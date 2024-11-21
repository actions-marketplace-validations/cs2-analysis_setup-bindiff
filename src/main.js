const core = require('@actions/core');
const exec = require('@actions/exec');
const io = require("@actions/io");
const tc = require('@actions/tool-cache');
const os = require('os');
const path = require('path');
const which = require('which')

const BASE_URL = 'https://github.com/cs2-analysis/bindiff';
const TOOL_NAME = 'BinDiff';

function getPlatform() {
  switch (os.platform()) {
    case 'win32':
      return 'Linux';
    case 'linux':
      return 'Linux';
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

function getZipName(osPlatform) {
  return `BinDiff-${osPlatform}`;
}

function getUrl(version, osPlatform) {
  const versionPart = version === 'latest' ? 'latest/download' : `download/${version}`;
  return `${BASE_URL}/releases/${versionPart}/${getZipName(osPlatform)}.zip`;
}

function exeName(name) {
  return os.platform() === 'win32' ? `${name}.exe` : name;
}

function dllName(name) {
  switch (os.platform()) {
    case 'win32':
      return `${name}.dll`;
    case 'linux':
      return `${name}.so`;
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

function getPluginsDir(base, name) {
  let dir = path.join('Plugins', name);

  switch (os.platform()) {
    case 'win32':
      break;
    default:
      dir = dir.replace(/ /g, '').toLowerCase();
      break;
  }

  return path.join(base, dir);
}

function getConfigDir() {
  switch (os.platform()) {
    case 'win32':
      return path.join(process.env.APPDATA, 'BinDiff');
    case 'linux':
      return path.join(process.env.HOME, '.bindiff');
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

async function findIdaDir() {
  // find ida executable in path
  const idaPath = await which('ida', {nothrow: true});
  if (!idaPath) {
    return null;
  }

  return path.dirname(idaPath);
}

async function download() {
  const osPlatform = getPlatform();
  core.debug(`platform: ${osPlatform}`);
  const osArch = os.arch();
  core.debug(`arch: ${osArch}`);
  if (osArch !== 'x64') {
    throw new Error(`Unsupported arch: ${osArch}`);
  }
  const version = core.getInput('version') || 'latest';
  core.debug(`version: ${version}`);

  core.info(`Checking cache for ${TOOL_NAME} version ${version}`);
  const cachePath = tc.find(TOOL_NAME, version);
  if (cachePath) {
    core.info(`Found in cache: ${cachePath}`);
    core.addPath(path.join(cachePath, 'bin'));
    return cachePath;
  } else {
    core.info(`Not found in cache`);
  }

  const url = getUrl(version, osPlatform);

  core.info(`Downloading ${TOOL_NAME} version ${version} from ${url}`);
  const downloadPath = await tc.downloadTool(url);
  core.debug(`downloadPath: ${downloadPath}`);

  core.info(`Extracting ${downloadPath}`);
  const extractPath = await tc.extractZip(downloadPath);
  core.debug(`extractPath: ${extractPath}`);

  const bindiffPath = path.join(extractPath, getZipName(osPlatform));

  if (!process.env.RUNNER_TEMP)
    throw new Error('Environment variable RUNNER_TEMP is not set');

  const outputPath = path.join(process.env.RUNNER_TEMP, `${TOOL_NAME}-${version}`);
  core.debug(`outputPath: ${outputPath}`);

  core.info(`Installing to ${outputPath}`);
  const binDir = path.join(outputPath, 'bin');
  await io.mkdirP(binDir);
  await io.mv(path.join(bindiffPath, exeName('bindiff')), binDir);
  await io.mv(path.join(bindiffPath, 'tools', exeName('bindiff_config_setup')), binDir);
  await io.mv(path.join(bindiffPath, 'tools', exeName('binexport2dump')), binDir);

  const idaPluginDir = getPluginsDir(outputPath, 'IDA Pro');
  await io.mkdirP(idaPluginDir);
  await io.mv(path.join(bindiffPath, 'ida', dllName('binexport12_ida')), idaPluginDir);
  await io.mv(path.join(bindiffPath, 'ida', dllName('bindiff8_ida')), idaPluginDir);

  const binjaPluginDir = getPluginsDir(outputPath, 'Binary Ninja');
  await io.mkdirP(binjaPluginDir);
  await io.mv(path.join(bindiffPath, 'binaryninja', dllName('binexport12_binaryninja')), binjaPluginDir);

  // mark as executable on linux
  if (osPlatform === 'linux') {
    await exec.exec('chmod', [
      '+x',
      ...['bindiff', 'bindiff_config_setup', 'binexport2dump'].map(name => path.join(binDir, name)),
    ]);
  }

  core.info(`Caching ${TOOL_NAME} in tool cache (${version})`);
  const newCachePath = await tc.cacheDir(outputPath, TOOL_NAME, version);
  core.debug(`newCachePath: ${newCachePath}`);

  core.addPath(path.join(newCachePath, 'bin'));
  return newCachePath;
}

async function setup(installPath) {
  core.info(`Setting up ${TOOL_NAME}`);

  const configDir = getConfigDir();
  await io.mkdirP(configDir);
  const configPath = path.join(configDir, 'bindiff.json');
  core.debug(`configPath: ${configPath}`);

  core.info(`Looking for IDA Pro installation`);
  const idaDir = await findIdaDir();
  if (!idaDir) {
    core.info('IDA Pro not found in path');
  } else {
    core.info(`Found IDA Pro at ${idaDir}`);
  }

  // setup paths
  await exec.exec('bindiff_config_setup', [
    '--config', configPath,
    `directory=${installPath}`,
    ...idaDir ? [`ida.directory=${idaDir}`] : [],
  ]);

  // setup disassembler plugins
  await exec.exec('bindiff_config_setup', ['--per_user']);

  // check version
  await exec.exec('bindiff', ['--version']);
}

async function run() {
  try {
    const installPath = await download();
    await setup(installPath);
    core.info('Successfully installed BinDiff');
  } catch (error) {
    core.setFailed(error.message);
  }
}

module.exports = {run}