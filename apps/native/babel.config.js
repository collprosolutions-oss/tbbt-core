module.exports = function nativeBabelConfig(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
