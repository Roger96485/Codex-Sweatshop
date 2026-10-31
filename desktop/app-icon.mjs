import {nativeImage} from 'electron';
import {fileURLToPath} from 'node:url';

export const appIconPath=fileURLToPath(new URL('./icon.png',import.meta.url));
let icon;
export function loadAppIcon() {
  icon??=nativeImage.createFromPath(appIconPath);
  if(icon.isEmpty())throw new Error('The application icon could not be loaded');
  return icon;
}
