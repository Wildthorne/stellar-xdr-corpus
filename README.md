# xdr-corpus-poc

Proof items for the SCF RFP **"XDR/CAP-Coverage Audit Tool and Indexer-Hardening Guide"** ([RFP track](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track#current-open-rfps)). The RFP treats a proposal as incomplete without three things:

| Required | Here |
|---|---|
| A draft manifest schema | [`schema/manifest.schema.json`](schema/manifest.schema.json) (JSON Schema 2020-12) |
| 2–3 sample corpus entries | 3 entries in [`corpus/`](corpus/manifest.json), real core output from Testnet, protocol 30 |
| Evidence of reproducing one listed sighting | [js-stellar-sdk#1766](https://github.com/stellar/js-stellar-sdk/pull/1766) reproduced from a corpus entry: [`repro/js-stellar-sdk-1766.log`](repro/js-stellar-sdk-1766.log) |

## The three entries

| ID | CAP | Shape | Sighting it targets |
|---|---|---|---|
| `cap0038-lp-trustline-issuer-order-01` | CAP-0038 | Liquidity pool trustline whose two issuers sort one way as strkey text and the other way as bytes | js-stellar-sdk#1766 (reproduced) |
| `cap0040-signed-payload-signer-padded-01` | CAP-0040 | `P…` signed-payload signer, 29-byte payload padded to 32 (signer key is 68 bytes, not 32) | wallet-backend#729, #716 |
| `cap0073-sac-trust-trustline-01` | CAP-0073 | Trustline created by SAC `trust()`: an InvokeHostFunction op, no ChangeTrust, no operation event | wallet-backend#731, stellar-etl#460 |

Each entry has four raw XDR files: `envelope`, `result`, `meta` (TransactionMeta) and `ledger_close_meta` (the whole ledger, what Galexie or `getLedgers` would hand a harness). The manifest records the ledger, tx hash, protocol, sha256 of every file, and the expected values as JSON Pointers into the SEP-0051 XDR-JSON that rs-stellar-xdr produces, so any language can check them.

## Run

```bash
npm install
node capture.mjs testnet       # generator: creates the shapes with fresh friendbot accounts, captures XDR
node build-manifest.mjs        # writes corpus/manifest.json
node verify.mjs                # 70 checks, see corpus/verify.log
node repro/js-stellar-sdk-1766.mjs
```

`capture.mjs` refuses any network but Testnet. Throwaway keys go to `.keys.testnet.json` (git-ignored). The captured files stay valid after the Dec 16, 2026 Testnet reset; rerunning the generator after the reset gives new accounts and IDs with the same shapes.

## What `verify.mjs` checks

1. Manifest valid against the schema.
2. sha256 of every file.
3. Byte-exact round trip of every file through **rs-stellar-xdr** (`stellar xdr decode` → `encode`, CLI 30.0.1) and through **js-stellar-sdk 17.4.0**.
4. Every expected value at its JSON Pointer.
5. The tx is in its ledger's LedgerCloseMeta, and its result and meta there are the same bytes as the standalone files.
6. Derived values computed independently: pool ID = sha256 of a hand-built `LiquidityPoolParameters`, issuer byte order vs text order, signed-payload length and padding.

## Finding while building it

For the Soroban entry the meta from RPC `getTransaction` and the copy inside RPC `getLedgers` differed by one value: diagnostic event `core_metrics / invoke_time_nsecs` (126023 vs 128834). It is wall-clock time measured by whichever node applied the ledger, so it is not consensus data. Everything else was identical. The schema now has `expected.nonconsensus` (pointers masked before byte comparison). This matters for the RFP's "agree with stellar-core's `--check-lcm` goldens" check: a corpus has to state which meta fields are node-local.

## Not done yet (proposal scope, not this proof)

- Comparison with stellar-core `--check-lcm` golden files.
- The same shapes generated on the Mainnet passphrase (generator is network-parametrised; only Testnet is enabled).
- Go and Rust SDK runs of the corpus (only JS here, plus the rs-stellar-xdr round trip).
- Running wallet-backend at pre-fix commits against entries 2 and 3.

## License

Apache-2.0, see [LICENSE](LICENSE). Built by [LimeChain](https://limechain.tech) as groundwork for a proposal to the Stellar Community Fund RFP track.
