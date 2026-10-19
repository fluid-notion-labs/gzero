// settings_screen.dart — hub URL + device token.
//
// The token is the same CX_TOKEN secret the desktop machines use; the
// test-connection button does a real health + headSeq round trip so bad
// config surfaces immediately.

import 'package:flutter/material.dart';

import '../api/hub_client.dart';
import '../state/sync_controller.dart';
import '../settings/settings_store.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, this.store, this.settings});

  /// Injectable for tests; production uses the real store.
  final SettingsStore? store;
  final Settings? settings;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final SettingsStore _store;
  late final TextEditingController _url;
  late final TextEditingController _token;
  String? _testResult;
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    _store = widget.store ?? SettingsStore();
    final initial = widget.settings ?? Settings();
    _url = TextEditingController(text: initial.hubUrl);
    _token = TextEditingController(text: initial.token);
  }

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    await _store.save(Settings(hubUrl: _url.text.trim(), token: _token.text.trim()));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('settings saved')));
      Navigator.of(context).pop();
    }
  }

  Future<void> _test() async {
    setState(() {
      _testing = true;
      _testResult = null;
    });
    final client = HubClient(baseUrl: _url.text.trim(), token: _token.text.trim());
    try {
      await client.health();
      final seq = await client.headSeq(systemStreams.first);
      setState(() {
        _testResult = 'ok — ${systemStreams.first} head seq $seq';
      });
    } catch (e) {
      setState(() {
        _testResult = e.toString();
      });
    }
    setState(() {
      _testing = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _url,
            decoration: const InputDecoration(
              labelText: 'hub url',
              hintText: defaultHubUrl,
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _token,
            decoration: const InputDecoration(labelText: 'device token (CX_TOKEN)'),
            obscureText: true,
          ),
          const SizedBox(height: 16),
          if (_testResult != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Text(_testResult!, style: Theme.of(context).textTheme.bodySmall),
            ),
          Row(
            children: [
              FilledButton(onPressed: _save, child: const Text('save')),
              const SizedBox(width: 12),
              OutlinedButton(
                onPressed: _testing ? null : _test,
                child: Text(_testing ? 'testing…' : 'test connection'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
