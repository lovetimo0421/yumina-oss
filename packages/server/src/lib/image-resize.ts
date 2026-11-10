import { deleteObject, getObjectBufferLimited, headObject, putObject } from "./s3.js";
import { createImageUploadProcessor } from "./image-upload-storage.js";

export const { prepareStoredImage, publishStoredImage, discardDirectImageUpload } = createImageUploadProcessor({
  head: headObject,
  read: getObjectBufferLimited,
  write: (key, bytes, type) => putObject(key, bytes, type, { signal: AbortSignal.timeout(30_000) }),
  remove: deleteObject,
});
