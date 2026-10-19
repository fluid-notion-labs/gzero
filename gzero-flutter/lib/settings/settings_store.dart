// settings_store.dart — device-side config: hub URL + device token.
//
// The token is the CX_TOKEN secret (same one the desktop machines use);
// stored as a JSON file in the app support directory for v0. A
// keychain/secure-storage move is the obvious later hardening.
// (shared_preferences hit a pigeon Dart/Android API mismatch in this
// SDK snapshot — path_provider's file API is the dependable path.)

import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../api/hub_client.dart';

class Settings {
  const Settings({this.hubUrl = defaultHubUrl, this.token = ''});
  final String hubUrl;
  final String token;

  Settings copyWith({String? hubUrl, String? token}) =>
      Settings(hubUrl: hubUrl ?? this.hubUrl, token: token ?? this.token);

  bool get hasToken => token.isNotEmpty;
}

class SettingsStore {
  Future<File> _file() async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/settings.json');
  }

  Future<Settings> load() async {
    try {
      final file = await _file();
      final body = await file.readAsString();
      final json = jsonDecode(body) as Map<String, dynamic>;
      return Settings(
        hubUrl: (json['hubUrl'] as String?) ?? defaultHubUrl,
        token: (json['token'] as String?) ?? '',
      );
    } on FileSystemException {
      return const Settings();
    } on FormatException {
      return const Settings();
    }
  }

  Future<void> save(Settings settings) async {
    final file = await _file();
    await file.writeAsString(jsonEncode({'hubUrl': settings.hubUrl, 'token': settings.token}), flush: true);
  }
}
