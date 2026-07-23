/// App configuration.
///
/// The Supabase URL + anon key are PUBLIC — they ship in every client bundle and
/// Row Level Security protects the data (same values the web app and the Capacitor
/// APK already embed). The OpenRouter key is NEVER in the client; all AI calls
/// (Cut Lord, transcription, captions) go through Supabase edge functions that hold
/// the key server-side.
///
/// Override at build time with:
///   flutter build apk --dart-define=SUPABASE_URL=... --dart-define=SUPABASE_ANON_KEY=...
class AppConfig {
  static const String supabaseUrl = String.fromEnvironment(
    'SUPABASE_URL',
    defaultValue: 'https://zlqxrdlognjvwqpmnfjq.supabase.co',
  );

  static const String supabaseAnonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    defaultValue:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpscXhyZGxvZ25qdndxcG1uZmpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MzI5MjMsImV4cCI6MjA5OTIwODkyM30.S7cUsW0NKk609CxaaDnQqQGv3RzmX5oCtaDMjxzLaAw',
  );
}
