import 'package:supabase_flutter/supabase_flutter.dart';

/// Call a Supabase edge function (same contract as the web app's invokeEdge):
/// POST to `/functions/v1/{name}` with the user JWT; returns the parsed JSON body.
Future<Map<String, dynamic>> invokeEdge(String name, Map<String, dynamic> body) async {
  final res = await Supabase.instance.client.functions.invoke(name, body: body);
  final data = res.data;
  if (data is Map) {
    final m = data.cast<String, dynamic>();
    if (m['error'] != null) throw Exception(m['error'].toString());
    return m;
  }
  throw Exception('Unexpected response from $name');
}
