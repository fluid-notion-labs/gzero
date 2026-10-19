// settings_store.dart — device-side config: hub URL + device token.
//
// The token is the CX_TOKEN secret (same one the desktop machines use);
// stored in SharedPreferences for v0. A keychain/secure-storage move is
// the obvious later hardening.

import 'package:shared_preferences/shared_preferences.dart';

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
  static const _urlKey = 'gzero.hubUrl';
  static const _tokenKey = 'gzero.token';

  Future<Settings> load() async {
    final prefs = await SharedPreferences.getInstance();
    return Settings(
      hubUrl: prefs.getString(_urlKey) ?? defaultHubUrl,
      token: prefs.getString(_tokenKey) ?? '',
    );
  }

  Future<void> save(Settings settings) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_urlKey, settings.hubUrl);
    await prefs.setString(_tokenKey, settings.token);
  }
}
