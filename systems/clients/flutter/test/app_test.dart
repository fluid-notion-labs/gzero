import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gzero_client/main.dart';
import 'package:gzero_client/settings/settings_store.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

class FakePathProvider extends PathProviderPlatform {
  @override
  Future<String?> getApplicationSupportPath() async =>
      (await Directory.systemTemp.createTemp('gzero-app-test')).path;
}

void main() {
  setUp(() {
    PathProviderPlatform.instance = FakePathProvider();
  });

  testWidgets('app shell: org root with offline banner and settings entry', (
    tester,
  ) async {
    // Unroutable port: connection refused immediately and deterministically,
    // so the shell ends in the unreachable state without network.
    await tester.pumpWidget(
      const GzeroApp(initialSettings: Settings(hubUrl: 'http://127.0.0.1:1')),
    );
    await tester.pumpAndSettle();
    expect(find.text('gzero'), findsOneWidget);
    expect(find.textContaining('hub unreachable'), findsOneWidget);
    expect(find.byIcon(Icons.cloud_off), findsNWidgets(2)); // banner + app bar
    expect(find.byTooltip('Settings'), findsOneWidget);
    expect(find.byTooltip('Sync status'), findsOneWidget);
  });

  testWidgets('sync status sheet opens from the app bar indicator', (tester) async {
    await tester.pumpWidget(
      const GzeroApp(initialSettings: Settings(hubUrl: 'http://127.0.0.1:1')),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Sync status'));
    await tester.pumpAndSettle();
    expect(find.text('hub unreachable'), findsOneWidget); // sheet headline
    expect(find.byTooltip('Refresh'), findsOneWidget);
  });

  testWidgets('settings screen opens, saves, and pops', (tester) async {
    final store = _RecordingStore();
    await tester.pumpWidget(
      GzeroApp(
        initialSettings: const Settings(hubUrl: 'http://127.0.0.1:1'),
        store: store,
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('settings'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'hub url'), 'https://new.test');
    await tester.enterText(find.widgetWithText(TextField, 'device token (CX_TOKEN)'), 'tok');
    await tester.tap(find.text('save'));
    await tester.pumpAndSettle();

    expect(store.saved?.hubUrl, 'https://new.test');
    expect(store.saved?.token, 'tok');
    // back on home after save
    expect(find.text('settings'), findsNothing);
  });
}

class _RecordingStore implements SettingsStore {
  Settings? saved;

  @override
  Future<Settings> load() async => saved ?? const Settings();

  @override
  Future<void> save(Settings settings) async {
    saved = settings;
  }
}
