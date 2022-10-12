import fs from 'fs';

const baseUrl = '/Users/Project/vite/packages/vite/demo/src/index.js';

(async () => {

    let loadPromise = addModuleSource(baseUrl);

    function runOptimizerWhenIdle () {
        const next = {
            done: async function () {
                await loadPromise;
            }
        }
        next
            .done()
            .then(() => {
                setTimeout(() => {
                    console.log('handle afterLoad');
                }, 100);
            })
    }

    async function transform () {
        runOptimizerWhenIdle();
        const source = '';
        return source;
    }

    class Program {
        constructor () {}
    } 

    function tryParse () {
        const code = '';
        const acornParser = {
            // 借助于 acore 的能力来进行解析源码生成 ast.
            parse: () => {}
        }
        return acornParser.parse(code);
    }

    function setSource () {
        let ast = tryParse();
        // 根据 acore 生成的 ast 递归实例化 node constructor.
        ast = new Program(ast, { type: 'Module' });
    }

    async function addModuleSource (id) {
        await fs.promises.readFile(id, 'utf8');
        setSource(await transform());
    }

    const fsDepModule = async (id) => {
        return fs.promises.readFile(id, 'utf8');
    }

    const depQueue = [];
    for (let i = 0; i < 1; ++i) {
        depQueue.push(fsDepModule(baseUrl));
    }

    await loadPromise;
    const t = new Date().getTime();
    console.time('dep load');
    await Promise.all(depQueue).then(() => {
        console.log('dep load success');
    })
    console.timeEnd('dep load');
})();