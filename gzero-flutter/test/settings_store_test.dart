import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/api/hub_client.dart';
import 'package:gzero_client/settings/settings_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('defaults: deployed hub url, empty token', () async {
    final s = await SettingsStore().load();
    expect(s.hubUrl, defaultHubUrl);
    expect(s.token, '');
    expect(s.hasToken, isFalse);
  });

  test('save then load round-trips', () async {
    final store = SettingsStore();
    await store.save(Settings(hubUrl: 'https://alt.test', token: 'tok'));
    final s = await store.load();
    expect(s.hubUrl, 'https://alt.test');
    expect(s.token, 'tok');
    expect(s.hasToken, isTrue);
  });
}
