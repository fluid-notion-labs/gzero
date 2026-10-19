import 'dart:io';
import '../lib/api/hub_client.dart';

Future<void> main() async {
  final token = File(Platform.environment['HOME']! + '/.config/gzero/hub-token').readAsStringSync().trim();
  final client = HubClient(baseUrl: 'https://gzero-hub.nick-hems.workers.dev', token: token);
  await client.health();
  for (final s in ['context', 'comms']) {
    stdout.writeln('$s head seq: ${await client.headSeq(s)}');
  }
  stdout.writeln('smoke: ok');
}
