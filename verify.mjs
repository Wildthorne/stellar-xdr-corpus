// Checks the corpus the way a reviewer would:
//  1. manifest.json is valid against schema/manifest.schema.json
//  2. every file matches its sha256
//  3. every file round-trips through rs-stellar-xdr (stellar xdr decode -> encode)
//     and through js-stellar-sdk, byte for byte
//  4. every expected value matches the rs-stellar-xdr JSON at its pointer
//  5. the transaction's meta is byte-identical to its copy inside the whole
//     ledger (LedgerCloseMeta), so the ledger file can feed a harness
//  6. derived values: pool ID = sha256(LiquidityPoolParameters), built by hand
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import { xdr, StrKey } from "@stellar/stellar-sdk";

const here = path.dirname(new URL(import.meta.url).pathname);
const corpus = path.join(here, "corpus");
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, "manifest.json"), "utf8"));
const schema = JSON.parse(fs.readFileSync(path.join(here, "schema", "manifest.schema.json"), "utf8"));
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`); if (!cond) fails++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ptr = (obj, p) => p.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const cli = (args, input) => execFileSync("stellar", ["xdr", ...args], { input, maxBuffer: 1 << 28 });

// 1. schema
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const valid = ajv.validate(schema, manifest);
ok(valid, `manifest valid against schema (${manifest.entries.length} entries)`);
if (!valid) console.log(ajv.errors);

for (const e of manifest.entries) {
  console.log(`\n${e.id}  [${e.caps.join(", ")}]  ${e.network.name} ledger ${e.source.ledger}  protocol ${e.protocol_version}`);
  const json = {};
  const bytes = {};
  for (const f of e.files) {
    const file = path.join(corpus, f.path);
    const b = fs.readFileSync(file);
    bytes[f.role] = b;
    // 2. hash
    ok(crypto.createHash("sha256").update(b).digest("hex") === f.sha256, `${f.role}: sha256`);
    // 3. round trip, Rust
    const j = cli(["decode", "--type", f.xdr_type, "--input", "single", "--output", "json", file]).toString();
    const back = cli(["encode", "--type", f.xdr_type, "--input", "json", "--output", "single"], j);
    ok(Buffer.compare(back, b) === 0, `${f.role}: rs-stellar-xdr round trip (${b.length} bytes)`);
    json[f.role] = JSON.parse(j);
    // 3. round trip, JS
    const js = Buffer.from(xdr[f.xdr_type].fromXDR(b).toXDR());
    ok(Buffer.compare(js, b) === 0, `${f.role}: js-stellar-sdk 17.4.0 round trip`);
  }
  // 4. expected values
  for (const x of e.expected.decoded || []) {
    const got = ptr(json[x.file], x.pointer);
    ok(same(got, x.equals), `${x.file}${x.pointer} = ${JSON.stringify(x.equals).slice(0, 60)}${same(got, x.equals) ? "" : `  (got ${JSON.stringify(got)})`}`);
  }
  if (e.expected.events !== undefined) {
    const n = json.meta.v4.operations.reduce((s, op) => s + op.events.length, 0);
    ok(n === e.expected.events, `operation-level contract events = ${e.expected.events}`);
  }
  // 5. tx inside the ledger
  if (bytes.ledger_close_meta) {
    const lcm = xdr.LedgerCloseMeta.fromXDR(bytes.ledger_close_meta).value;
    // SDK 17 wraps opaque typedefs (Hash): its XDR is the 32 raw bytes.
    const hit = lcm.txProcessing.find((t) => Buffer.from(t.result.transactionHash.toXDR()).toString("hex") === e.source.tx_hash);
    ok(!!hit, `tx ${e.source.tx_hash.slice(0, 12)}… found among ${lcm.txProcessing.length} txs of ledger ${e.source.ledger}`);
    if (hit) {
      const lcmMeta = Buffer.from(hit.txApplyProcessing.toXDR());
      if (Buffer.compare(lcmMeta, bytes.meta) === 0) ok(true, "meta identical to the copy in LedgerCloseMeta");
      else {
        // Compare again with the entry's non-consensus fields removed.
        const mask = (j) => { for (const n of e.expected.nonconsensus || []) { const parts = n.pointer.split("/").slice(1); const last = parts.pop(); const parent = ptr(j, "/" + parts.join("/")); if (parent) delete parent[last]; } return j; };
        const other = JSON.parse(cli(["decode", "--type", "TransactionMeta", "--input", "single", "--output", "json"], lcmMeta).toString());
        const masked = (e.expected.nonconsensus || []).length > 0 && same(mask(structuredClone(json.meta)), mask(other));
        console.log(`  note meta bytes differ from the LedgerCloseMeta copy (${e.expected.nonconsensus?.map((n) => n.pointer).join(", ") || "no non-consensus fields declared"})`);
        ok(masked, "meta identical to the copy in LedgerCloseMeta once non-consensus fields are masked");
      }
      ok(Buffer.compare(Buffer.from(hit.result.result.toXDR()), bytes.result) === 0, "result identical to the copy in LedgerCloseMeta");
    }
    ok(lcm.ledgerHeader.header.ledgerVersion === e.protocol_version, `ledger protocol = ${e.protocol_version}`);
  }
  // 6. derived values with an independent computation
  for (const d of e.expected.derived || []) {
    if (d.name === "liquidity_pool_id_hex") {
      const p = ptr(json.envelope, "/tx/tx/operations/2/body/change_trust/line/pool_share/liquidity_pool_constant_product");
      const asset = (a) => xdr.Asset.assetTypeCreditAlphanum4(new xdr.AlphaNum4({
        assetCode: Buffer.from(a.credit_alphanum4.asset_code.padEnd(4, "\0")),
        issuer: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(a.credit_alphanum4.issuer)),
      }));
      const params = xdr.LiquidityPoolParameters.liquidityPoolConstantProduct(new xdr.LiquidityPoolConstantProductParameters({ assetA: asset(p.asset_a), assetB: asset(p.asset_b), fee: p.fee }));
      const id = crypto.createHash("sha256").update(params.toXDR()).digest("hex");
      ok(id === d.value, `derived ${d.name} = sha256(params) ${id.slice(0, 16)}…`);
      const bytesOrder = Buffer.compare(StrKey.decodeEd25519PublicKey(p.asset_a.credit_alphanum4.issuer), StrKey.decodeEd25519PublicKey(p.asset_b.credit_alphanum4.issuer));
      const textOrder = p.asset_a.credit_alphanum4.issuer < p.asset_b.credit_alphanum4.issuer ? -1 : 1;
      ok(bytesOrder < 0 && textOrder > 0, "issuers: a < b by bytes, a > b as strkey text");
    }
    if (d.name === "signer_key_bytes") {
      const raw = StrKey.decodeSignedPayload(ptr(json.meta, "/v4/operations/0/changes/1/updated/data/account/signers/0/key"));
      ok(raw.length === d.value, `derived ${d.name} = ${raw.length}`);
    }
    if (d.name === "signed_payload_hex") {
      const raw = StrKey.decodeSignedPayload(ptr(json.envelope, "/tx/tx/operations/0/body/set_options/signer/key"));
      const sp = xdr.SignerKeyEd25519SignedPayload.fromXDR(Buffer.from(raw));
      ok(Buffer.from(sp.payload).toString("hex") === d.value, `derived ${d.name} (${sp.payload.length} bytes)`);
    }
  }
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
