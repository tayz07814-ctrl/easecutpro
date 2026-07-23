import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'config.dart';
import 'screens/auth_screen.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Portrait-first, like the React app.
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
  ]);
  // Supabase is best-effort: the editor (import / preview / export) works fully
  // offline; login / sync / Cut Lord connect when online.
  try {
    await Supabase.initialize(
      url: AppConfig.supabaseUrl,
      // Legacy JWT anon key (public, RLS-protected) — the value the web app already
      // ships. `anonKey` is the correct param for it.
      // ignore: deprecated_member_use
      anonKey: AppConfig.supabaseAnonKey,
    );
  } catch (_) {}
  runApp(const EaseCutApp());
}

class EaseCutApp extends StatelessWidget {
  const EaseCutApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EaseCut',
      debugShowCheckedModeBanner: false,
      theme: Ec.themeData(),
      home: const AuthScreen(),
    );
  }
}
