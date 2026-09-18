# 04 · 导入 AllPet（最后一步：加载宠物）

做完 `make_pet.py` 后，你手上有这个安装目录（**内部只含两个文件**）：

```text
my-pet/petdex-package/my-pet/
├── pet.json
└── spritesheet.webp
```

把这个目录导入 AllPet，宠物就能在桌面上动起来。AllPet 兼容 `pet.json + 8×9 或 8×11 图集`，本包产出的是 v2（8×11）。

---

## 方法一：命令行导入（推荐）

```bash
cd 你的 all-pet 仓库目录
./allpet pet import "/绝对路径/宠物生成标准包/my-pet/petdex-package/my-pet"
```

导入后切换并重启让它生效：

```bash
./allpet pet set "我的宠物"     # 用 displayName 或 id 都行
./allpet restart                # GUI 已在运行时才需要
```

查看已安装列表：

```bash
./allpet pet list
```

## 方法二：菜单栏导入

1. 点 macOS 菜单栏的 **🐾**；
2. 打开 **Pet**；
3. 选 **Import local pet…**，选中上面的 `my-pet` 文件夹；
4. 在 Pet 列表里点它的缩略图即可切换。

---

## 换宠与缩略图

- 菜单里每个已装宠物都会显示**缩略图**，点击即切。
- 缩略图由 AllPet 从 `spritesheet.webp` 自动生成（取图集首帧/基准格），无需你另做。
- 切换后若 GUI 没反应，跑 `./allpet restart`。

## 宠物被装到哪

导入的宠物落在 `~/.config/all-pet/pets/<id>/`，当前使用哪个记在 `~/.config/all-pet/config.json` 的 `pet.bundlePath`。想卸载就把对应目录删掉再 `./allpet restart`。

---

## 排查

| 现象 | 处理 |
|---|---|
| 导入后列表里没有 | `./allpet pet list` 看是否在；确认目录里确实只有 pet.json + spritesheet.webp 两个文件 |
| 切了没变化 | `./allpet restart` |
| 图集不显示/报错 | 先回 `03` 跑 `validate.py`，确认 1536×2288、73 有效格、版本字段=2 |
| 具体报错 | `./allpet logs` 看 `~/.config/all-pet/allpet.log`；`./allpet self-test` 自检 |

> 命令以你实际 AllPet 版本为准，完整说明见 all-pet 仓库 `README.md` 的「Changing the pet」一节。
