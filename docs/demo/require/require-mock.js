// 导入依赖
const path = require('path'); // 路径操作
const fs = require('fs'); // 文件读取
const vm = require('vm'); // 文件执行

// 定义模块, 添加文件id标识和exports属性
function Module(id) {
  this.id = id;
  // 读取到的文件内容会放在exports中
  this.exports = {};
}
// 定义包裹模块内容的函数
Module.wrapper = [
  "(function(exports, module, Require, __dirname, __filename) {",
  "})"
]
// 定义扩展名，不同的扩展名，加载方式不同，实现js和json
Module._extensions = {
  '.js'(module) {
    const content = fs.readFileSync(module.id, 'utf8');
    const fnStr = Module.wrapper[0] + content + Module.wrapper[1];
    const fn = vm.runInThisContext(fnStr);
    fn.call(module.exports, module.exports, module, Require, __filename, __dirname);
  },
  '.json'(module) {
    const json = fs.readFileSync(module.id, 'utf8');
    module.exports = JSON.parse(json); // 把文件的结果放在exports属性上
  }
}

Module._cache = {};

// 定义模块加载方法
function tryModuleLoad(module) {
  // 获取扩展名
  const extension = path.extname(module.id);
  // 通过后缀加载当前模块
  Module._extensions[extension](module);
}

// 定义导入类，参数为模块路径
function Require(modulePath) {
  // 获取当前要加载的绝对路径
  let absPathname = path.resolve(__dirname, modulePath);
  // 获取所有后缀名
  const extNames = Object.keys(Module._extensions);
  let index = 0;
  // 存储原始文件路径
  const oldPath = absPathname;
  function findExt(absPathname) {
    if (index === extNames.length) {
      return new Error('文件不存在');
    }
    try {
      fs.accessSync(absPathname);
      return absPathname;
    } catch (e) {
      const ext = extNames[index++];
      findExt(oldPath + ext);
    }
  }
  // 递归追加后缀名，判断文件是否存在
  absPathname = findExt(absPathname);
  // 从缓存中读取，如果存在，直接返回结果
  if (Module._cache[absPathname]) {
    return Module._cache[absPathname].exports;
  }
  // 创建模块，新建Module实例
  const module = new Module(absPathname);
  // 添加缓存
  Module._cache[absPathname] = module;
  // 加载当前模块
  tryModuleLoad(module);
  // 返回exports对象
  return module.exports;
}

const demo = Require('./demo.js');
console.log('require-mock demo value: ', demo.value);