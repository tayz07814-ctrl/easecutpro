import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'cloud/backend.dart';
import 'config.dart';
import 'editor/silence_settings.dart';
import 'local/app_settings.dart';
import 'screens/auth_screen.dart';
import 'screens/dashboard_screen.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Portrait-first, like the React app.
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
  ]);
  // App preferences (STT provider, silence engine, seam fade) — loaded before
  // the first frame so every read is a plain synchronous static.
  await AppSettings.load();
  SilenceSettings.seamOverlapMs = AppSettings.crossFadeMs;
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
      // Restore the persisted Supabase session: skip login if already signed in.
      home: Backend.signedIn ? const DashboardScreen() : const AuthScreen(),
    );
  }
}
