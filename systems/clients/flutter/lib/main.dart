// main.dart — the gzero Flutter client.
//
// One repo, in-tree: this app lives at gzero-flutter/ inside the gzero
// repository and speaks to the same hub the desktop machines do
// (research/flutter-client.md). v0 surface: sync status card over the
// system streams; projects list and messaging land as their data planes
// come online.

import 'package:flutter/material.dart';

import 'api/hub_client.dart';
import 'settings/settings_store.dart';
import 'state/sync_controller.dart';
import 'ui/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const GzeroApp());
}

class GzeroApp extends StatefulWidget {
  const GzeroApp({super.key, this.store, this.initialSettings});

  /// Injectable for tests; production uses the real store.
  final SettingsStore? store;
  /// Preloaded settings skip the async load (tests).
  final Settings? initialSettings;

  @override
  State<GzeroApp> createState() => _GzeroAppState();
}

class _GzeroAppState extends State<GzeroApp> {
  late Settings _settings;
  late SyncController _controller;
  late HubClient _client;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    if (widget.initialSettings != null) {
      _settings = widget.initialSettings!;
      _rebuild();
      _loaded = true;
    } else {
      _settings = Settings();
      _load();
    }
  }

  Future<void> _load() async {
    final settings = await (widget.store ?? SettingsStore()).load();
    setState(() {
      _settings = settings;
      _loaded = true;
    });
    _rebuild();
  }

  void _rebuild() {
    _client = HubClient(baseUrl: _settings.hubUrl, token: _settings.token);
    _controller = SyncController(_client);
    _controller.refresh();
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) {
      return const MaterialApp(home: Scaffold(body: Center(child: CircularProgressIndicator())));
    }
    return MaterialApp(
      title: 'gzero',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3D5AFE)),
        useMaterial3: true,
      ),
      home: HomeScreen(
        controller: _controller,
        onSettingsChanged: _load,
        settingsStore: widget.store,
      ),
    );
  }
}
