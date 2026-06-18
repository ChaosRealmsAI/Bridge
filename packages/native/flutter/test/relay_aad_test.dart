import 'package:panda_bridge/panda_bridge.dart';
import 'package:test/test.dart';

void main() {
  group('BridgeRelayAad.relayEnvelopeAadText', () {
    test('8-segment full version matches spec sample byte-for-byte', () {
      final aad = BridgeRelayAad.relayEnvelopeAadText(
        productId: 'acme-chat',
        deviceId: 'dev_1',
        channelId: 'acme_chat',
        direction: 'product_to_device',
        seq: 7,
        authorizationId: 'auth_1',
        authorizationEpoch: 3,
        relayKeyId: 'rkx_test',
      );
      expect(
        aad,
        'product:acme-chat|device:dev_1|channel:acme_chat|direction:product_to_device|seq:7|authorization:auth_1|epoch:3|relay_key:rkx_test',
      );
    });

    test('5-segment base version when authorization/relayKey absent', () {
      final aad = BridgeRelayAad.relayEnvelopeAadText(
        productId: 'acme-chat',
        deviceId: 'dev_1',
        channelId: 'acme_chat',
        seq: 1,
      );
      expect(
        aad,
        'product:acme-chat|device:dev_1|channel:acme_chat|direction:product_to_device|seq:1',
      );
    });

    test('base version when only authorizationId is set', () {
      final aad = BridgeRelayAad.relayEnvelopeAadText(
        productId: 'p',
        deviceId: 'd',
        channelId: 'c',
        seq: 2,
        authorizationId: 'auth_1',
      );
      expect(aad, 'product:p|device:d|channel:c|direction:product_to_device|seq:2');
    });

    test('blank direction falls back to product_to_device', () {
      final aad = BridgeRelayAad.relayEnvelopeAadText(
        productId: 'p',
        deviceId: 'd',
        channelId: 'c',
        direction: '',
        seq: 0,
      );
      expect(aad, 'product:p|device:d|channel:c|direction:product_to_device|seq:0');
    });
  });

  group('BridgeRelayAad.relayKeyBootstrapAadText', () {
    test('matches official sample', () {
      final aad = BridgeRelayAad.relayKeyBootstrapAadText(
        productId: 'acme-chat',
        deviceId: 'dev_1',
        authorizationId: 'auth_1',
        authorizationEpoch: 3,
        keyId: 'rkx_test',
      );
      expect(aad, 'bridge-relay-key-bootstrap-v1|acme-chat|dev_1|auth_1|3|rkx_test');
    });
  });
}
