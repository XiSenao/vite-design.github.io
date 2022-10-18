(async () => {
    const p = new Promise((r) => {
        r(1);
    }).then(async r => { 
        console.log('ffff');
        await new Promise((r) => {
            setTimeout(() => {
                r(1);
            }, 2000);
        });
    });
    console.log('1');
    await p;
    console.log('2');
})();