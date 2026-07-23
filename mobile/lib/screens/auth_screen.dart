import 'package:flutter/material.dart';

import '../theme.dart';
import 'dashboard_screen.dart';

/// Login / sign-up (AuthScreen.tsx). UI + navigation only for now — real Supabase
/// email/password auth is wired in the next pass.
class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  bool _signup = false;
  bool _busy = false;
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_email.text.isEmpty || _password.text.isEmpty) return;
    setState(() => _busy = true);
    // Backend auth comes next; for now proceed to the dashboard.
    await Future<void>.delayed(const Duration(milliseconds: 350));
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const DashboardScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF17181C),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(22),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Brand
                RichText(
                  textAlign: TextAlign.center,
                  text: const TextSpan(
                    style: TextStyle(
                        fontSize: 30, fontWeight: FontWeight.w800, color: Ec.text, letterSpacing: -0.5),
                    children: [
                      TextSpan(text: 'EaseCut'),
                      TextSpan(text: 'Pro', style: TextStyle(color: Ec.indigo)),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  _signup ? 'Create your account' : 'Welcome back',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Ec.textMute, fontSize: 14),
                ),
                const SizedBox(height: 26),
                _field(_email, 'Email', keyboard: TextInputType.emailAddress),
                const SizedBox(height: 12),
                _field(_password, 'Password', obscure: true),
                const SizedBox(height: 20),
                GestureDetector(
                  onTap: _busy ? null : _submit,
                  child: Container(
                    height: 50,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: Ec.indigo,
                      borderRadius: BorderRadius.circular(12),
                      boxShadow: [
                        BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6)),
                      ],
                    ),
                    child: Text(
                      _busy ? 'Please wait…' : (_signup ? 'Create account' : 'Log in'),
                      style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700),
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(_signup ? 'Already have an account? ' : 'New here? ',
                        style: const TextStyle(color: Ec.textMute, fontSize: 13)),
                    GestureDetector(
                      onTap: () => setState(() => _signup = !_signup),
                      child: Text(_signup ? 'Log in' : 'Create one',
                          style: const TextStyle(color: Ec.indigoText, fontSize: 13, fontWeight: FontWeight.w600)),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _field(TextEditingController c, String hint,
      {bool obscure = false, TextInputType? keyboard}) {
    return TextField(
      controller: c,
      obscureText: obscure,
      keyboardType: keyboard,
      style: const TextStyle(color: Ec.text, fontSize: 14),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Ec.textFaint),
        filled: true,
        fillColor: const Color(0xFF101014),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.1)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: Ec.indigo),
        ),
      ),
    );
  }
}
