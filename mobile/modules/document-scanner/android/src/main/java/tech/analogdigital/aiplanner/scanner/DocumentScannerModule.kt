package tech.analogdigital.aiplanner.scanner

import android.app.Activity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class ScanOptions : Record {
  @Field var pageLimit: Int = 10
}

// Google's document scanner: finds the page, straightens it and cleans it up, on the device.
// The scanner runs in Google Play services, so the app needs no camera permission for it.
class DocumentScannerModule : Module() {
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("DocumentScanner")

    AsyncFunction("isAvailableAsync") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }

    // Resolves with the file URIs of the scanned pages (JPEG), or an empty list when cancelled.
    AsyncFunction("scanAsync") { options: ScanOptions, promise: Promise ->
      if (pending != null) {
        promise.reject("ERR_SCAN_IN_PROGRESS", "The scanner is already open.", null)
        return@AsyncFunction
      }
      val activity = appContext.throwingActivity
      val scanner = GmsDocumentScanning.getClient(
        GmsDocumentScannerOptions.Builder()
          .setGalleryImportAllowed(true)
          .setPageLimit(options.pageLimit.coerceIn(1, 20))
          .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
          .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
          .build()
      )
      pending = promise
      scanner.getStartScanIntent(activity)
        .addOnSuccessListener { sender ->
          try {
            activity.startIntentSenderForResult(sender, REQUEST_CODE, null, 0, 0, 0)
          } catch (e: Exception) {
            pending = null
            promise.reject("ERR_SCANNER_UNAVAILABLE", e.message ?: "The scanner couldn't open.", e)
          }
        }
        .addOnFailureListener { e ->
          pending = null
          promise.reject("ERR_SCANNER_UNAVAILABLE", e.message ?: "The scanner isn't available.", e)
        }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val promise = pending ?: return@OnActivityResult
      pending = null
      if (payload.resultCode != Activity.RESULT_OK) {
        promise.resolve(emptyList<String>())
        return@OnActivityResult
      }
      val result = GmsDocumentScanningResult.fromActivityResultIntent(payload.data)
      promise.resolve(result?.pages?.map { it.imageUri.toString() } ?: emptyList<String>())
    }
  }

  companion object {
    private const val REQUEST_CODE = 0x5CA2
  }
}
