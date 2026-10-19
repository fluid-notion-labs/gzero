import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/api/hub_client.dart';
import 'package:gzero_client/settings/settings_store.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

class FakePathProvider extends PathProviderPlatform {
  final Future<Directory> dir = Directory.systemTemp.createTemp('gzero-test');
  @override
  Future<String?> getApplicationSupportPath() async => (await dir).path;
}

void main() {
  late FakePathProvider paths;

  setUp(() {
    paths = FakePathProvider();
    PathProviderPlatform.instance = paths;
  });

  test('defaults when no file exists: deployed hub url, empty token', () async {
    final s = await SettingsStore().load();
    expect(s.hubUrl, defaultHubUrl);
    expect(s.token, '');
    expect(s.hasToken, isFalse);
  });

  test('save then load round-trips through the file', () async {
    final store = SettingsStore();
    await store.save(const Settings(hubUrl: 'https://alt.test', token: 'tok'));
    expect(File('${(await paths.dir).path}/settings.json').existsSync(), isTrue);
    final s = await store.load();
    expect(s.hubUrl, 'https://alt.test');
    expect(s.token, 'tok');
    expect(s.hasToken, isTrue);
  });

  test('corrupt file falls back to defaults', () async {
    final store = SettingsStore();
    await store.save(const Settings());
    await File('${(await paths.dir).path}/settings.json').writeAsString('{not json');
    final s = await store.load();
    expect(s.hubUrl, defaultHubUrl);
    expect(s.hasToken, isFalse);
  });
}
