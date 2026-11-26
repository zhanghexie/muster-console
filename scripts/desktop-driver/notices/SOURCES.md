# Cua Driver 0.59.4 源码与许可材料

本目录补充发行包内的 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。Node 原生运行时采用 MPL-2.0；其上游声明见 `node-runtime-NOTICE.md`，许可证正文见 `MPL-2.0.txt`。

- Cua Driver 对应版本及脚本：<https://github.com/trycua/cua/tree/01207bbf0ddcc0f2bb9642322c4e8b4b02319d1b/libs/cua-driver>
- Node 运行时的上游源归档：<https://registry.npmjs.org/uniffi-bindgen-react-native/-/uniffi-bindgen-react-native-0.31.0-3.tgz>
- Cua 对上述源的修改脚本：<https://github.com/trycua/cua/blob/01207bbf0ddcc0f2bb9642322c4e8b4b02319d1b/libs/cua-driver/scripts/build-node-runtime.mjs>，含回调缓存补丁 <https://github.com/trycua/cua/blob/01207bbf0ddcc0f2bb9642322c4e8b4b02319d1b/libs/cua-driver/scripts/node-runtime-trampoline-cache.rs>。
- TypeScript 绑定依赖：<https://registry.npmjs.org/@ubjs/core/-/core-0.31.0-3.tgz> 和 <https://registry.npmjs.org/@ubjs/node/-/node-0.31.0-3.tgz>；对应上游源码分别见 <https://github.com/jhugman/uniffi-bindgen-react-native/tree/49bc59194d183a05855ed4104c18eb92fb465e02> 与 <https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449>。

分发方还需保存与实际二进制对应的上游源、修改结果、完整依赖及适用许可，并核查源码可获取性。此清单不表示完整依赖审查、签名验证或分发准入已经完成。
