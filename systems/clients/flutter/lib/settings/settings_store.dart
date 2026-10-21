// settings_store.dart — device-side config: hub URL + device token.
//
// The token is the CX_TOKEN secret (same one the desktop machines use);
// stored as a JSON file in the app support directory for v0. A
// keychain/secure-storage move is the obvious later hardening.
// (shared_preferences hit a pigeon Dart/Android API mismatch in this
// SDK snapshot — path_provider's file API is the dependable path.)

import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:path_provider/path_provider.dart';

import '../api/hub_client.dart';

class Settings {
  const Settings({this.hubUrl = defaultHubUrl, this.token = '', this.sender = ''});
  final String hubUrl;
  final String token;

  /// This device's identity on outgoing comms messages. Generated once
  /// and persisted; empty until the first load creates it.
  final String sender;

  Settings copyWith({String? hubUrl, String? token, String? sender}) => Settings(
        hubUrl: hubUrl ?? this.hubUrl,
        token: token ?? this.token,
        sender: sender ?? this.sender,
      );

  bool get hasToken => token.isNotEmpty;
  bool get canSend => sender.isNotEmpty;
}

/// A fresh sender id: tablet-<6 random hex chars>.
String newSender() {
  final r = Random();
  final suffix = List.generate(6, (_) => r.nextInt(16).toRadixString(16)).join();
  return 'tablet-$suffix';
}

class SettingsStore {
  Future<File> _file() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/settings.json');
  }

  Future<Settings> load() async {
    var settings = const Settings();
    try {
      final file = await _file();
      final body = await file.readAsString();
      final json = jsonDecode(body) as Map<String, dynamic>;
      settings = Settings(
        hubUrl: (json['hubUrl'] as String?) ?? defaultHubUrl,
        token: (json['token'] as String?) ?? '',
        sender: (json['sender'] as String?) ?? '',
      );
    } on FileSystemException {
      // first run: defaults below
    } on FormatException {
      // corrupt settings: defaults below
    }
    // Every device needs a stable sender identity for comms; mint one
    // on first load and persist it immediately.
    if (settings.sender.isEmpty) {
      settings = settings.copyWith(sender: newSender());
      await save(settings);
    }
    return settings;
  }

  Future<void> save(Settings settings) async {
    final file = await _file();
    await file.writeAsString(
      jsonEncode({'hubUrl': settings.hubUrl, 'token': settings.token, 'sender': settings.sender}),
      flush: true,
    );
  }
}
