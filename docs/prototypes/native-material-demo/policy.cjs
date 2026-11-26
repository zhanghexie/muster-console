const MATERIALS = ['acrylic', 'mica', 'solid'];

function supportedMaterials(platform, release, hasNativeMethod = true) {
  if (platform === 'darwin' && hasNativeMethod) return ['acrylic', 'solid'];
  const [major, , build] = release.split('.').map(Number);
  if (platform === 'win32' && hasNativeMethod && major >= 10 && build >= 22621) return MATERIALS.slice();
  return ['solid'];
}

function validateOptions(patch, supported) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的材质选项');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'material') {
      if (!supported.includes(value)) throw new Error('此平台不支持该材质');
    } else if (key === 'theme') {
      if (value !== 'dark' && value !== 'light') throw new Error('无效的主题');
    } else if (key === 'tint') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 45) throw new Error('叠层浓度应为 0–45');
    } else if (key === 'reference') {
      if (typeof value !== 'boolean') throw new Error('无效的对照背景状态');
    } else {
      throw new Error('未知的材质选项');
    }
    result[key] = value;
  }
  return result;
}

module.exports = { supportedMaterials, validateOptions };
