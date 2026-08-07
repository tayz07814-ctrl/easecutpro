# ONNX Runtime — MUST NOT be renamed or stripped.
#
# ORT's native C++ resolves its Java types by NAME at runtime
# (FindClass/GetMethodID inside convertToTensorInfo, called while converting a
# session's OUTPUT back into Java objects). When R8 renames those classes the
# lookup returns null and the JNI layer aborts the whole process:
#
#   JNI DETECTED ERROR IN APPLICATION: java_class == null
#     in call to GetMethodID
#     from ai.onnxruntime.OrtSession.run(...)
#   signal 6 (SIGABRT) ... com.easecutpro.easecut:vadengine
#
# That is the crash that killed BOTH on-device engines (FSMN before, Silero
# now) on release builds — never a model, device or audio problem.
-keep class ai.onnxruntime.** { *; }
-keepclassmembers class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**

# Our own classes: kept so any future native crash prints a READABLE stack
# (this crash log arrived as "o1.q.c", which is SilenceEngine obfuscated).
-keep class com.easecutpro.easecut.** { *; }
