const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);

async function buildWindowsHelper(cacheDirectory = path.join(os.tmpdir(), 'openwhip-native')) {
  const sourceDirectory = path.join(__dirname, '..', 'native');
  const sources = ['CodexInput.cs', 'Worker.cs'].map(name => path.join(sourceDirectory, name));
  const digest = crypto.createHash('sha256');
  for (const source of sources) digest.update(fs.readFileSync(source));
  const outputDirectory = path.join(cacheDirectory, digest.digest('hex').slice(0, 24));
  const executable = path.join(outputDirectory, 'OpenWhip.Input.exe');
  if (fs.existsSync(executable)) return executable;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const framework = path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('Whip needs the Windows .NET Framework 4.x desktop runtime.');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporary = path.join(outputDirectory, `OpenWhip.Input.${process.pid}.exe`);
  const references = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll']
    .map(name => `/reference:${path.join(framework, 'WPF', name)}`);
  try {
    await execute(compiler, [
      '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${temporary}`,
      '/reference:System.Web.Extensions.dll', ...references, ...sources,
    ], { windowsHide: true, timeout: 30000 });
    fs.renameSync(temporary, executable);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* Nothing was compiled. */ }
    throw new Error(`Could not build Windows input helper: ${error.stdout || error.message}`);
  }
  return executable;
}

module.exports = { buildWindowsHelper };
