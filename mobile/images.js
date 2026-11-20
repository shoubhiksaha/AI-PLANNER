// Photos from the document scanner or the share sheet, prepared for the page: JPEG, at most
// MAX_SIDE pixels on the longer side (plenty for handwriting, small enough to hand over quickly).
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { fitWithin, normalizeFileUri } from './bridge';

const MAX_SIDE = 2400;
const QUALITY = 0.85;

async function toJpegBase64(rawUri) {
  const uri = normalizeFileUri(rawUri);
  const original = await ImageManipulator.manipulate(uri).renderAsync();
  let image = original;
  try {
    const size = fitWithin(original.width, original.height, MAX_SIDE);
    if (size) image = await ImageManipulator.manipulate(uri).resize(size).renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: QUALITY, base64: true });
    return saved.base64;
  } finally {
    original.release?.();
    if (image !== original) image.release?.();
  }
}

/**
 * [{ name, mimeType, base64 }] for the page; photos that can't be read are left out.
 * Each source is a URI or a list of URIs to try in turn (a shared photo: the app's copy, then the
 * sender's original content:// link).
 */
export async function preparePageImages(sources, prefix) {
  const images = [];
  for (const [i, source] of sources.entries()) {
    for (const uri of [].concat(source).filter(Boolean)) {
      try {
        const base64 = await toJpegBase64(uri);
        if (base64) {
          images.push({ name: `${prefix}-${i + 1}.jpg`, mimeType: 'image/jpeg', base64 });
          break;
        }
      } catch (e) {
        console.warn('Preparing a photo failed:', e);
      }
    }
  }
  return images;
}
