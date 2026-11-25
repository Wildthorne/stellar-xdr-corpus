// Reproduces js-stellar-sdk#1766 with a real corpus entry: a liquidity pool
// trustline that Testnet core accepted, whose issuers sort differently as
// strkey text and as bytes.
//
// Runs the same calls an indexer or wallet makes on three SDK versions:
//   17.2.0  last release before the fix   (expected: rejects valid ledger data)
//   17.2.1  first release with the fix    (expected: decodes it)
//   17.4.0  current
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const corpus = path.join(here, "..", "corpus");
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, "manifest.json"), "utf8"));
const entry = manifest.entries.find((e) => e.id === "cap0038-lp-trustline-issuer-order-01");
const envelope = fs.readFileSync(path.join(corpus, entry.files.find((f) => f.role === "envelope").path)).toString("base64");
const poolHex = entry.expected.derived.find((d) => d.name === "liquidity_pool_id_hex").value;
const [issuerA, issuerB] = ["asset_a", "asset_b"].map((k) => entry.expected.decoded.find((x) => x.pointer.includes(`/${k}/`)).equals);

const versions = [
  ["17.2.0", "sdk-17-2-0", "before fix"],
  ["17.2.1", "sdk-17-2-1", "fix"],
  ["17.4.0", "@stellar/stellar-sdk", "current"],
];
const out = [];
const log = (s = "") => { console.log(s); out.push(s); };
const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, value: e.message }; } };

log(`js-stellar-sdk#1766 reproduction, ${new Date().toISOString()}`);
log(`corpus entry ${entry.id}: ${entry.network.name} ledger ${entry.source.ledger}, tx ${entry.source.tx_hash}`);
log(`issuer A ${issuerA}`);
log(`issuer B ${issuerB}`);
log(`core's order (bytes): A then B. Plain text order: ${[issuerA, issuerB].sort()[0] === issuerB ? "B then A" : "A then B"}`);
log(`pool ID from core's meta: ${poolHex}`);

const results = {};
for (const [ver, pkg, label] of versions) {
  const sdk = await import(pkg);
  const { TransactionBuilder, Asset, getLiquidityPoolId, LiquidityPoolAsset, Networks } = sdk;
  const A = new Asset("XDRC", issuerA);
  const B = new Asset("XDRC", issuerB);
  log(`\n== @stellar/stellar-sdk ${ver} (${label})`);

  // 1. Indexer path: parse the transaction core accepted.
  const parsed = attempt(() => {
    const tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
    const line = tx.operations[2].line;
    return `ok, op[2] = ${tx.operations[2].type} on pool ${line.getLiquidityPoolParameters ? "(" + line.getLiquidityPoolParameters().fee + " bps)" : ""}`;
  });
  log(`  TransactionBuilder.fromXDR(envelope)          -> ${parsed.ok ? parsed.value : "THROWS: " + parsed.value}`);

  // 2. Pool ID from the pool's assets, in core's order.
  const pid = attempt(() => Buffer.from(getLiquidityPoolId("constant_product", { assetA: A, assetB: B, fee: 30 })).toString("hex"));
  log(`  getLiquidityPoolId(A, B, 30)                  -> ${pid.ok ? (pid.value === poolHex ? "matches core" : "WRONG " + pid.value) : "THROWS: " + pid.value}`);

  // 3. Wallet path: build the same pool share asset.
  const lpa = attempt(() => new LiquidityPoolAsset(A, B, 30).toString());
  log(`  new LiquidityPoolAsset(A, B, 30)              -> ${lpa.ok ? "ok" : "THROWS: " + lpa.value}`);

  // 4. The comparison underneath.
  const cmp = attempt(() => Asset.compare(A, B));
  log(`  Asset.compare(A, B)                           -> ${cmp.value} (core: -1)`);

  results[ver] = parsed.ok && pid.ok && pid.value === poolHex && lpa.ok && cmp.value === -1;
}

log("\nsummary");
for (const [ver, , label] of versions) log(`  ${ver.padEnd(7)} ${label.padEnd(11)} ${results[ver] ? "decodes the ledger correctly" : "REJECTS valid ledger data"}`);
const reproduced = !results["17.2.0"] && results["17.2.1"] && results["17.4.0"];
log(`\n${reproduced ? "REPRODUCED: fails before the fix, passes from the fix on" : "NOT reproduced"}`);
fs.writeFileSync(path.join(here, "js-stellar-sdk-1766.log"), out.join("\n") + "\n");
process.exit(reproduced ? 0 : 1);
