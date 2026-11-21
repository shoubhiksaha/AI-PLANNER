// Google's document scanner (Android). Elsewhere, or in builds without the module, it is unavailable.
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

const Native = Platform.OS === 'android' ? requireOptionalNativeModule('DocumentScanner') : null;

export async function isScannerAvailableAsync() {
  if (!Native) return false;
  try {
    return await Native.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Opens the scanner; resolves with the page image URIs (empty when cancelled). */
export function scanPagesAsync({ pageLimit = 10 } = {}) {
  if (!Native) return Promise.reject(new Error('The document scanner is not available.'));
  return Native.scanAsync({ pageLimit });
}
