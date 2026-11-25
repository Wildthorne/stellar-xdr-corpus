// Turns corpus/capture.<net>.json into corpus/manifest.json.
// Expected values come from what the generator asked for (accounts, payload)
// and from what core wrote into the meta (pool ID), never from an SDK helper,
// so the manifest can judge SDKs.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { StrKey } from "@stellar/stellar-sdk";

const NET = process.argv[2] || "testnet";
const here = path.dirname(new URL(import.meta.url).pathname);
const cap = JSON.parse(fs.readFileSync(path.join(here, "corpus", `capture.${NET}.json`), "utf8"));
const by = Object.fromEntries(cap.entries.map((e) => [e.id, e]));
const XDR_TYPES = { envelope: "TransactionEnvelope", result: "TransactionResult", meta: "TransactionMeta", ledger_close_meta: "LedgerCloseMeta" };
const I64_MAX = "9223372036854775807";
const SDK_1766 = "https://github.com/stellar/js-stellar-sdk/pull/1766";

function base(e, extra) {
  return {
    id: e.id,
    protocol_version: e.protocol_version,
    network: { name: e.network, passphrase: e.passphrase },
    source: {
      kind: "network-history", ledger: e.ledger, tx_hash: e.tx_hash, op_index: e.op_index,
      close_time: e.close_time, captured_via: "RPC getTransaction (envelope, result, meta) + getLedgers (ledger_close_meta)",
      ...extra.source,
    },
    synthetic: false,
    files: Object.entries(e.files).map(([role, f]) => ({ role, xdr_type: XDR_TYPES[role], path: f.path, encoding: "binary", sha256: f.sha256, size: f.size })),
  };
}

// rs-stellar-xdr (through the Stellar CLI) is the reference decoder.
const decode = (type, file) => JSON.parse(execFileSync("stellar", ["xdr", "decode", "--type", type, "--input", "single", "--output", "json", path.join(here, "corpus", file)], { encoding: "utf8" }));

const lp = by["cap0038-lp-trustline-issuer-order-01"];
// The pool ID as core computed it, read from the created liquidity pool entry.
const lpPoolStrkey = decode("TransactionMeta", lp.files.meta.path).v4.operations[2].changes
  .find((c) => c.created?.data?.liquidity_pool).created.data.liquidity_pool.liquidity_pool_id;
const sp = by["cap0040-signed-payload-signer-padded-01"];
const tr = by["cap0073-sac-trust-trustline-01"];
const poolPath = "/tx/tx/operations/2/body/change_trust/line/pool_share/liquidity_pool_constant_product";

const entries = [
  {
    ...base(lp, { source: { recipe: "capture.mjs step 1: two issuers whose strkeys share position 1, one with a letter and one with a digit at position 2; holder trusts both, then ChangeTrust on the pool share" } }),
    title: "Liquidity pool trustline whose asset issuers sort one way as strkey text and the other way as bytes",
    caps: ["CAP-0038"],
    min_protocol: 18,
    shape: {
      where: "TransactionEnvelope.tx.operations[2].body.change_trust.line.pool_share",
      what: "Core orders pool assets by XDR bytes. Base32 puts A-Z (0-25) before 2-7 (26-31), ASCII puts digits first, so sorting G-strkeys as text reverses this pair. A decoder that checks order by text rejects a valid ledger.",
    },
    tags: ["liquidity-pool", "asset-order", "strkey", "sdk-divergence"],
    expected: {
      round_trip: true,
      decoded: [
        { file: "envelope", pointer: `${poolPath}/asset_a/credit_alphanum4/issuer`, equals: lp.asset_a, why: "lower by XDR bytes, higher as text" },
        { file: "envelope", pointer: `${poolPath}/asset_b/credit_alphanum4/issuer`, equals: lp.asset_b },
        { file: "envelope", pointer: `${poolPath}/fee`, equals: 30 },
        { file: "result", pointer: "/result/tx_success/2/op_inner/change_trust", equals: "success" },
        { file: "meta", pointer: "/v4/operations/2/changes/7/created/data/liquidity_pool/liquidity_pool_id", equals: lpPoolStrkey },
        { file: "meta", pointer: "/v4/operations/2/changes/0/created/data/trustline/asset/pool_share", equals: lpPoolStrkey },
      ],
      derived: [
        { name: "liquidity_pool_id_hex", value: Buffer.from(StrKey.decodeLiquidityPool(lpPoolStrkey)).toString("hex"), how: "sha256 of the XDR of LiquidityPoolParameters with assets in XDR byte order" },
        { name: "issuers_in_strkey_text_order", value: [lp.asset_b, lp.asset_a], ordered: true, how: "plain string sort of the two issuer strkeys; the reverse of core's order" },
      ],
    },
    sightings: [
      { url: SDK_1766, component: "js-stellar-sdk", fixed_in: "17.2.1 (16.3.1 on the 16.x line)", reproduced: true, evidence: "../repro/js-stellar-sdk-1766.log" },
    ],
    notes: "The RFP says the Go SDK hit and fixed the same bug earlier; this entry has not been run through the Go SDK yet.",
  },
  {
    ...base(sp, { source: { recipe: "capture.mjs step 2: SetOptions adds an ed25519 signed-payload signer over the account's own key, payload 29 bytes" } }),
    title: "Signed-payload signer (P… strkey) with a payload that needs XDR padding",
    caps: ["CAP-0040"],
    min_protocol: 19,
    shape: {
      where: "TransactionEnvelope.tx.operations[0].body.set_options.signer.key (ed25519_signed_payload)",
      what: "Signer key is 32-byte key + 4-byte length + 29-byte payload padded to 32 (68 bytes), not the 32 bytes most code assumes. Stored into a 32-byte column it halts or silently truncates ingestion.",
    },
    tags: ["signer", "signed-payload", "strkey", "padding", "variable-length-key"],
    expected: {
      round_trip: true,
      decoded: [
        { file: "envelope", pointer: "/tx/tx/operations/0/body/set_options/signer/key", equals: sp.signer },
        { file: "envelope", pointer: "/tx/tx/operations/0/body/set_options/signer/weight", equals: 1 },
        { file: "result", pointer: "/result/tx_success/0/op_inner/set_options", equals: "success" },
        { file: "meta", pointer: "/v4/operations/0/changes/1/updated/data/account/signers/0/key", equals: sp.signer, why: "the stored signer is the full P… key, not its base G… account" },
      ],
      derived: [
        { name: "signed_payload_hex", value: sp.payload_hex, how: "payload field of SignerKeyEd25519SignedPayload, without padding" },
        { name: "signed_payload_len", value: sp.payload_len, how: "length prefix of the payload" },
        { name: "signer_key_bytes", value: 68, how: "32 (ed25519) + 4 (length) + 29 payload padded to 32" },
      ],
    },
    sightings: [
      { url: "https://github.com/stellar/wallet-backend/pull/729", component: "wallet-backend", reproduced: false },
      { url: "https://github.com/stellar/wallet-backend/issues/716", component: "wallet-backend", reproduced: false },
    ],
  },
  {
    ...base(tr, { source: { recipe: "capture.mjs step 3: deploy the SAC for XDRC:issuerA, then a fresh account calls SAC trust(own address)" } }),
    title: "Trustline created by the Stellar Asset Contract trust() function, with no ChangeTrust operation and no contract event",
    caps: ["CAP-0073"],
    min_protocol: 26,
    shape: {
      where: "TransactionMeta.v4.operations[0].changes[0].created.data.trustline (op is invoke_host_function)",
      what: "The trustline appears only as a ledger entry change under an InvokeHostFunction op. The op emits no event, so indexers that derive trustline history from ChangeTrust ops or from events miss it.",
    },
    tags: ["sac", "trustline", "soroban", "no-event", "participants-from-meta"],
    expected: {
      round_trip: true,
      events: 0,
      nonconsensus: [
        { pointer: "/v4/diagnostic_events", why: "Diagnostic events are emitted only when a node enables them, and core_metrics/invoke_time_nsecs is wall-clock time measured by that node. On capture, RPC getTransaction and getLedgers returned this tx with invoke_time_nsecs 126023 vs 128834; everything else was identical." },
      ],
      decoded: [
        { file: "envelope", pointer: "/tx/tx/operations/0/body/invoke_host_function/host_function/invoke_contract/function_name", equals: "trust" },
        { file: "envelope", pointer: "/tx/tx/operations/0/body/invoke_host_function/host_function/invoke_contract/contract_address", equals: tr.sac },
        { file: "meta", pointer: "/v4/operations/0/changes/0/created/data/trustline/account_id", equals: tr.truster },
        { file: "meta", pointer: "/v4/operations/0/changes/0/created/data/trustline/asset/credit_alphanum4/issuer", equals: tr.asset.split(":")[1] },
        { file: "meta", pointer: "/v4/operations/0/changes/0/created/data/trustline/limit", equals: I64_MAX, why: "CAP-0073: trust() always creates an unlimited trustline" },
        { file: "meta", pointer: "/v4/operations/0/events", equals: [], why: "no operation-level event; only the transaction-level fee events exist" },
      ],
      derived: [
        { name: "trustline_added", value: [`${tr.truster}|${tr.asset}`], how: "meta change with no pre-state and a trustline post-state, under any op type" },
      ],
    },
    sightings: [
      { url: "https://github.com/stellar/wallet-backend/issues/731", component: "wallet-backend", reproduced: false },
      { url: "https://github.com/stellar/stellar-etl/issues/460", component: "stellar-etl", reproduced: false },
    ],
  },
];

const manifest = {
  schema_version: "0.1",
  generator: { name: "xdr-corpus-poc capture.mjs", version: "0.1.0", notes: `captured ${cap.captured_at} via ${cap.rpc}` },
  entries,
};
fs.writeFileSync(path.join(here, "corpus", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`manifest: ${entries.length} entries`);
