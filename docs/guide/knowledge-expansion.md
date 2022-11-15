---
sidebarDepth: 3
---

# 知识扩展

## 为什么 zsh 启动慢

### 问题

`oh-my-zsh` 适配了 `zsh` 后发现 `zsh` 启动需要等待一段时间。通过执行 `\time zsh -i -c exit` 检测了下 `zsh` 启动时间，输出结果如下：

```bash
~ \time zsh -i -c exit
    3.79 real         0.17 user         0.18 sys
```

可以发现加载 `zsh` 模块需要耗费 `3.79s` 的时间，这其实对于开发来说会显得格外别扭。

### 优化手段

`zprof` 是一款 `zsh` 自带的性能检测工具，可以用很快的方式来检测 `zsh` 运行时的消耗。使用方式通过在 `~/.zshrc` 模块顶部添加 `zmodload zsh/zprof` 指令然后重新执行 `zshrc`(重启控制台)。在重新开启的控制台中输入 `zprof` 指令，可以看到如下输出：

```bash
num  calls                time                       self            name
-----------------------------------------------------------------------------------
 1)    1        3394.58  3394.58   78.49%   3394.58  3394.58   78.49%  is_update_available
 2)    2         656.08   328.04   15.17%    654.53   327.26   15.13%  bracketed-paste-magic
 3)    1         218.95   218.95    5.06%     82.34    82.34    1.90%  nvm_auto
 4)    2         136.61    68.31    3.16%     70.00    35.00    1.62%  nvmss

-----------------------------------------------------------------------------------
```

可以发现 `is_update_available` 项加载时间占据着 **`78.49%`**。意味着启动 `oh-my-zsh` 的时候会进行检测更新。因此可以在 `.zshrc` 模块执行 `source $ZSH/oh-my-zsh.sh` 指令之前禁止掉 `oh-my-zsh` 自动更新检测就可以了。

#### [禁止自动检测更新有以下两种实现方案](https://cloud.tencent.com/developer/ask/sof/115329)

1. **不推荐使用的修改设置的方法(`.zshrc` 中的环境变量)**

   ```bash
   DISABLE_AUTO_UPDATE=true
   ```

2. **修改设置的推荐方法(`zstyle` 设置)**

    ```bash
    zstyle ':omz:update' mode disabled
    ```

重启 `zsh` 后就可以顺畅运行。

```bash
~ \time zsh -i -c exit
    0.34 real         0.14 user         0.16 sys
```
