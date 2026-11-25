// Generator: creates three rare ledger shapes on a network and captures the
// raw XDR core emitted for them (envelope, result, meta, whole ledger).
//
//   node capture.mjs [testnet]
//
// Uses fresh throwaway accounts funded by friendbot. Their keys go to
// .keys.<net>.json (git-ignored) so a rerun reuses them. No existing
// identity is touched. Nothing here may run on Mainnet.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  Keypair, Asset, LiquidityPoolAsset, Operation, TransactionBuilder, Networks,
  StrKey, xdr, Contract, Address, rpc, BASE_FEE,
} from "@stellar/stellar-sdk";

const NET = process.argv[2] || "testnet";
const NETS = {
  testnet: {
    passphrase: Networks.TESTNET,
    rpc: "https://soroban-testnet.stellar.org",
    friendbot: "https://friendbot.stellar.org",
  },
};
if (!NETS[NET]) throw new Error(`unsupported network ${NET} (Mainnet is never allowed)`);
const { passphrase, rpc: RPC, friendbot } = NETS[NET];
const server = new rpc.Server(RPC);
const here = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(here, "corpus");
const CODE = "XDRC";

// ---------- keys ----------
const keyFile = path.join(here, `.keys.${NET}.json`);
const B32 = /^[A-Z]$/;
function issuerPair() {
  // Two issuers whose strkeys sort one way as text and the other way as bytes.
  // Position 1 of a G-strkey is always A-D; position 2 is the first free base32
  // char. Base32 maps A-Z to 0-25 and 2-7 to 26-31, but in ASCII digits sort
  // before letters. So "GAB…" < "GA3…" by bytes and "GA3…" < "GAB…" as text.
  let a, b;
  do { a = Keypair.random(); } while (!B32.test(a.publicKey()[2]));
  do { b = Keypair.random(); } while (!(b.publicKey()[1] === a.publicKey()[1] && /[2-7]/.test(b.publicKey()[2])));
  return [a, b];
}
function loadKeys() {
  if (fs.existsSync(keyFile)) {
    const k = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    return Object.fromEntries(Object.entries(k).map(([n, s]) => [n, Keypair.fromSecret(s)]));
  }
  const [issuerA, issuerB] = issuerPair();
  const keys = { issuerA, issuerB, lpHolder: Keypair.random(), signerAcct: Keypair.random(), sacTruster: Keypair.random() };
  fs.writeFileSync(keyFile, JSON.stringify(Object.fromEntries(Object.entries(keys).map(([n, kp]) => [n, kp.secret()])), null, 2), { mode: 0o600 });
  return keys;
}

// ---------- network helpers ----------
async function rawRpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function fund(kp) {
  try { await server.getAccount(kp.publicKey()); return; } catch {}
  const r = await fetch(`${friendbot}?addr=${kp.publicKey()}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(tx, label) {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${label}: ${sent.errorResult?.toXDR("base64")}`);
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const raw = await rawRpc("getTransaction", { hash: sent.hash });
    if (raw.status === "SUCCESS") return { hash: sent.hash, raw };
    if (raw.status === "FAILED") throw new Error(`${label} failed: ${raw.resultXdr}`);
  }
  throw new Error(`${label}: not confirmed`);
}
// Resume after a crash without resending (a resend would capture an update,
// not the creation): RESUME_<LABEL>=<tx hash>, e.g. RESUME_LP=ab12…
async function resumed(label) {
  const hash = process.env[`RESUME_${label}`];
  if (!hash) return null;
  const raw = await rawRpc("getTransaction", { hash });
  if (raw.status !== "SUCCESS") throw new Error(`RESUME_${label}: ${raw.status}`);
  return { hash, raw };
}
async function classic(source, ops, label) {
  const acct = await server.getAccount(source.publicKey());
  let b = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: passphrase });
  for (const op of ops) b = b.addOperation(op);
  const tx = b.setTimeout(120).build();
  tx.sign(source);
  return submit(tx, label);
}
async function soroban(source, op, label) {
  const acct = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: passphrase }).addOperation(op).setTimeout(120).build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(source);
  return submit(prepared, label);
}

// ---------- capture ----------
async function save(id, { hash, raw }, extra) {
  const dir = path.join(OUT, "entries", id);
  fs.mkdirSync(dir, { recursive: true });
  const lg = await rawRpc("getLedgers", { startLedger: raw.ledger, pagination: { limit: 1 } });
  const ledger = lg.ledgers[0];
  if (ledger.sequence !== raw.ledger) throw new Error("getLedgers returned another ledger");
  const files = {
    envelope: raw.envelopeXdr,
    result: raw.resultXdr,
    meta: raw.resultMetaXdr,
    ledger_close_meta: ledger.metadataXdr,
  };
  const written = {};
  for (const [role, b64] of Object.entries(files)) {
    const bytes = Buffer.from(b64, "base64");
    fs.writeFileSync(path.join(dir, `${role}.xdr`), bytes);
    written[role] = { path: `entries/${id}/${role}.xdr`, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }
  // SDK 17: unions and structs expose fields as properties, not methods.
  const header = xdr.LedgerCloseMeta.fromXDR(files.ledger_close_meta, "base64").value.ledgerHeader.header;
  return {
    id, network: NET, passphrase, ledger: raw.ledger, tx_hash: hash,
    close_time: new Date(Number(header.scpValue.closeTime) * 1000).toISOString(),
    protocol_version: header.ledgerVersion,
    application_order: raw.applicationOrder, files: written, ...extra,
  };
}

const keys = loadKeys();
console.log("accounts:", Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, k.publicKey()])));
for (const kp of Object.values(keys)) await fund(kp);
await sleep(6000);

const A = new Asset(CODE, keys.issuerA.publicKey());
const B = new Asset(CODE, keys.issuerB.publicKey());
const captured = [];

// 1. CAP-0038: liquidity pool trustline whose issuers sort differently as text
//    and as bytes (js-stellar-sdk#1766). Core orders pool assets by XDR bytes.
{
  const pool = new LiquidityPoolAsset(A, B, 30); // fixed SDK, byte order
  const r = (await resumed("LP")) || await classic(keys.lpHolder, [
    Operation.changeTrust({ asset: A }),
    Operation.changeTrust({ asset: B }),
    Operation.changeTrust({ asset: pool }),
  ], "lp trustline");
  captured.push(await save("cap0038-lp-trustline-issuer-order-01", r, {
    op_index: 2, asset_a: A.getIssuer(), asset_b: B.getIssuer(), code: CODE, fee: 30,
  }));
  console.log("1 lp trustline", r.hash);
}

// 2. CAP-0040: ed25519 signed-payload signer with a payload whose length is not
//    a multiple of 4, so the XDR carries padding (wallet-backend#729, #716).
{
  const payload = crypto.createHash("sha256").update("xdr-corpus signed payload").digest().subarray(0, 29);
  const spk = new xdr.SignerKeyEd25519SignedPayload({ ed25519: keys.signerAcct.rawPublicKey(), payload });
  const strkey = StrKey.encodeSignedPayload(spk.toXDR());
  const r = await classic(keys.signerAcct, [Operation.setOptions({ signer: { ed25519SignedPayload: strkey, weight: 1 } })], "signed payload signer");
  captured.push(await save("cap0040-signed-payload-signer-padded-01", r, {
    op_index: 0, signer: strkey, payload_hex: payload.toString("hex"), payload_len: payload.length,
  }));
  console.log("2 signed payload signer", r.hash);
}

// 3. CAP-0073: trustline created by the Stellar Asset Contract's trust(), with
//    no ChangeTrust op and no contract event (wallet-backend#731).
{
  const sacId = A.contractId(passphrase);
  try {
    await soroban(keys.issuerA, Operation.createStellarAssetContract({ asset: A }), "deploy SAC");
  } catch (e) {
    if (!String(e).includes("ExistingValue") && !String(e).includes("already")) console.log("SAC deploy:", String(e).slice(0, 200));
  }
  const r = await soroban(keys.sacTruster, new Contract(sacId).call("trust", new Address(keys.sacTruster.publicKey()).toScVal()), "SAC trust");
  captured.push(await save("cap0073-sac-trust-trustline-01", r, {
    op_index: 0, sac: sacId, asset: `${CODE}:${A.getIssuer()}`, truster: keys.sacTruster.publicKey(),
  }));
  console.log("3 SAC trust", r.hash);
}

fs.writeFileSync(path.join(OUT, `capture.${NET}.json`), JSON.stringify({ captured_at: new Date().toISOString(), rpc: RPC, entries: captured }, null, 2));
console.log(`wrote ${captured.length} entries to corpus/`);
