// Browser bundle of @gandlaf21/bc-ur (MIT): only the decoder, for NUT-16 animated cashu QRs.
import { URDecoder } from '@gandlaf21/bc-ur';
/** Feed "ur:bytes/…" frames; returns the decoded string once complete, else null. Throws if the result is bad. */
export function makeURDecoder() {
  const d = new URDecoder();
  return {
    receive(part) {
      try {
        d.receivePart(part);
      } catch {
        return null; // a misread frame (bytewords checksum): skip it, keep what we have
      }
      if (!d.isComplete()) return null;
      if (!d.isSuccess()) throw new Error(d.resultError());
      return d.resultUR().decodeCBOR().toString();
    },
    progress: () => d.estimatedPercentComplete(),
    expected: () => d.expectedPartCount(),
  };
}
