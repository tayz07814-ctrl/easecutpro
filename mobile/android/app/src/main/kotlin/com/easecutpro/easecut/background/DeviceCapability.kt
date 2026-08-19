package com.easecutpro.easecut.background

import android.app.ActivityManager
import android.content.Context
import android.os.Build

/**
 * Detects device capability and selects a quality tier for background removal.
 * Uses actual hardware signals rather than marketing names.
 */
object DeviceCapability {

    enum class Tier { FAST, BALANCED, HIGH_QUALITY }

    /** Thread count available to the process (reflects big+little core count). */
    private fun coreCount(): Int = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)

    /** Total RAM in MB. */
    private fun totalRamMb(context: Context): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        return info.totalMem / (1024 * 1024)
    }

    /**
     * Determine the best quality tier for this device.
     *
     * Decision matrix:
     *   - 4+ cores AND >= 4GB RAM  → HIGH_QUALITY
     *   - 2+ cores AND >= 2GB RAM  → BALANCED
     *   - else                     → FAST
     */
    fun detect(context: Context): Tier {
        val cores = coreCount()
        val ram = totalRamMb(context)
        return when {
            cores >= 4 && ram >= 4000 -> Tier.HIGH_QUALITY
            cores >= 2 && ram >= 2000 -> Tier.BALANCED
            else -> Tier.FAST
        }
    }

    /** Number of ONNX inference threads for the given tier. */
    fun inferenceThreads(tier: Tier): Int = when (tier) {
        Tier.FAST -> 1
        Tier.BALANCED -> 2
        Tier.HIGH_QUALITY -> 4
    }

    /** Model input resolution for the given tier. */
    fun modelSize(tier: Tier): Int = when (tier) {
        Tier.FAST -> 256
        Tier.BALANCED -> 256
        Tier.HIGH_QUALITY -> 256 // Same model, but stronger post-processing
    }

    /** Edge refinement kernel radius. */
    fun edgeRadius(tier: Tier): Int = when (tier) {
        Tier.FAST -> 0  // skip edge refinement
        Tier.BALANCED -> 3
        Tier.HIGH_QUALITY -> 5
    }

    /** Temporal smoothing alpha (0 = no smoothing, 1 = fully previous frame). */
    fun temporalAlpha(tier: Tier): Float = when (tier) {
        Tier.FAST -> 0.15f
        Tier.BALANCED -> 0.3f
        Tier.HIGH_QUALITY -> 0.4f
    }

    /** Confidence threshold for person detection. */
    fun confidenceThreshold(tier: Tier): Float = when (tier) {
        Tier.FAST -> 0.4f
        Tier.BALANCED -> 0.5f
        Tier.HIGH_QUALITY -> 0.55f
    }
}
