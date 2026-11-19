import 'dart:convert';
import 'package:http/http.dart' as http;

Future<List<dynamic>> loadPosts() async {
  const baseUrl = 'https://YOUR-VOXYDB-WORKER.workers.dev';
  const projectId = 'YOUR_PROJECT_ID';
  const readOnlyKey = 'YOUR_READ_ONLY_KEY';
  final uri = Uri.parse('$baseUrl/v1/projects/$projectId/collections/posts/records?limit=50');
  final response = await http.get(uri, headers: {
    'Authorization': 'Bearer $readOnlyKey',
    'Accept': 'application/json',
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Exception('VoxyDB request failed: ${response.statusCode} ${response.body}');
  }
  final jsonBody = jsonDecode(response.body) as Map<String, dynamic>;
  return jsonBody['records'] as List<dynamic>;
}
