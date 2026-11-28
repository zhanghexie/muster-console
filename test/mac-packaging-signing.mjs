import assert from 'node:assert/strict';
import { macSigningEnvironment, selectMacSigning, sign, verifySigningDetails } from '../scripts/build-mac.mjs';

const selected = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const other = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const developerId = `  1) ${selected} "Developer ID Application: Example Company (TEAM000001)"`;
const otherDeveloperId = `  2) ${other} "Developer ID Application: Another Company (TEAM000002)"`;
const development = `  2) ${other} "Apple Development: Example Person (TEAM000001)"`;
const invalidDeveloperId = `${otherDeveloperId} (CSSMERR_TP_CERT_EXPIRED)`;
const keychain = () => [developerId, invalidDeveloperId, development, '     2 valid identities found'].join('\n');
const multiple = () => [developerId, otherDeveloperId, '     2 valid identities found'].join('\n');
const adHoc = { mode: 'ad-hoc', identity: '-' };
const stable = { mode: 'developer-id', identity: selected };

assert.deepEqual(selectMacSigning({}, keychain), stable);
assert.deepEqual(selectMacSigning({ CSC_NAME: selected.toLowerCase() }, multiple), stable);
assert.deepEqual(selectMacSigning({ CSC_NAME: 'Example Company (TEAM000001)' }, multiple), stable);
assert.deepEqual(selectMacSigning({ CSC_NAME: 'Developer ID Application: Example Company (TEAM000001)' }, multiple), stable);
assert.throws(() => selectMacSigning({}, multiple), /Multiple Developer ID/);
assert.throws(() => selectMacSigning({ CSC_NAME: other }, keychain), /did not match/);
assert.throws(() => selectMacSigning({}, () => { throw new Error('Could not read Keychain'); }), /Could not read Keychain/);
assert.deepEqual(selectMacSigning({}, () => development), adHoc);
assert.deepEqual(selectMacSigning({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, () => assert.fail('keychain discovery is disabled')), adHoc);
assert.deepEqual(selectMacSigning({ CSC_LINK: 'fixture-certificate' }, () => assert.fail('configured certificate precedes discovery')),
  { mode: 'developer-id' });
assert.deepEqual(selectMacSigning({ CSC_KEYCHAIN: '/tmp/muster-signing.keychain-db' }, keychainPath => {
  assert.equal(keychainPath, '/tmp/muster-signing.keychain-db');
  return developerId;
}), stable);
const imported = { CSC_LINK: 'fixture-certificate', CSC_NAME: selected, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
assert.deepEqual(macSigningEnvironment(imported), { CSC_LINK: 'fixture-certificate', CSC_IDENTITY_AUTO_DISCOVERY: 'true' });
assert.equal(imported.CSC_NAME, selected, 'selecting the imported certificate must not modify the parent environment');
assert.deepEqual(macSigningEnvironment({ CSC_LINK: ' ', CSC_NAME: selected }), { CSC_NAME: selected });

const options = { identity: selected, app: 'App.app', identityValidation: false, optionsForFile: () => ({}) };
const builder = identity => ({ platformSpecificBuildOptions: { identity } });
await sign(options, builder(selected), async actual => assert.equal(actual, options,
  'the local signer must use the resolved hash rather than the certificate name'));
await sign(options, builder(undefined), async actual => assert.equal(actual.identity, selected));
await sign({ ...options, identity: '-' }, builder('-'), async actual => assert.equal(actual.identity, '-'));
await assert.rejects(sign({ ...options, identity: other }, builder(selected), () => assert.fail('must not sign with the wrong certificate')),
  /does not match the requested certificate fingerprint/);
await assert.rejects(sign({ ...options, identity: 'Developer ID Application: Example Company (TEAM000001)' }, builder(selected),
  () => assert.fail('a certificate name does not identify the selected certificate')), /did not resolve an exact certificate fingerprint/);

const appId = 'com.example.desktop';
const sealedBundle = [`Identifier=${appId}`, 'Info.plist entries=32', 'Sealed Resources version=2 rules=13 files=1'];
verifySigningDetails([...sealedBundle, 'Signature=adhoc', 'TeamIdentifier=not set'].join('\n'), appId, true);
verifySigningDetails([...sealedBundle, 'Authority=Developer ID Application: Example Company (TEAM000001)',
  'TeamIdentifier=TEAM000001'].join('\n'), appId, false);
assert.throws(() => verifySigningDetails(`Identifier=${appId}\nSignature=adhoc\nInfo.plist=not bound\nSealed Resources=none`, appId, true), /sealed/);
assert.throws(() => verifySigningDetails([...sealedBundle, 'Signature=adhoc'].join('\n'), appId, false), /expected Developer ID/);

console.log('macOS packaging signing: pinned Developer ID selection, explicit certificate, ambiguity, failure and ad-hoc fallback passed');
