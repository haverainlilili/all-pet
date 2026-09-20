# -*- coding: utf-8 -*-
"""
gen_adapter.py —— 图生图适配器接口（可插拔）。

generate.py 只调用 adapter.generate(ref_path, prompt, out_path, config, meta)。
换 API 只需实现这一个方法（或直接改 CustomAdapter），其余流程不变。

- MockAdapter   不联网，画占位图，用于端到端跑通流程（默认）。
- CustomAdapter ★ 把你的「参考图 + prompt -> 图」API 填进 generate() 即可。
- OpenAIAdapter 一个"参考实现"示例（images.edit，需 `pip install requests`）。

generate() 约定：
  ref_path  参考图路径（保持身份用；可为 None 表示无参考）
  prompt    固定动作模板文本（来自 gen_prompts.py，不要改动）
  out_path  输出 PNG 路径（本函数负责把结果图保存到这里）
  config    dict，来自 config.json（放 api_key / model / size 等）
  meta      可选 {'state','frame','strip_n'}，仅供 mock 变化与调试，真实 API 可忽略
"""
import os


def _ensure_dir(path):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)


class MockAdapter:
    """不联网的占位生成器：按 state/frame 画个简单团子，验证流程用。"""
    name = "mock"
    _palette = {
        "idle": (245, 166, 35), "running-right": (66, 165, 245),
        "running-left": (66, 165, 245), "waving": (255, 200, 60),
        "jumping": (120, 200, 90), "failed": (235, 120, 120),
        "waiting": (160, 140, 220), "running": (90, 170, 160),
        "review": (200, 140, 200), "look-directions": (180, 160, 120),
    }

    def generate(self, ref_path, prompt, out_path, config, meta=None):
        from PIL import Image, ImageDraw
        meta = meta or {}
        state = meta.get("state", "idle")
        frame = meta.get("frame", 0)
        n = meta.get("strip_n", 1)
        cell = 256
        color = self._palette.get(state, (200, 200, 200))
        im = Image.new("RGBA", (cell * n, cell), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for k in range(n):
            x0 = k * cell
            bob = ((frame + k) % 3) * 6
            d.ellipse((x0 + 48, 40 + bob, x0 + 208, 232 + bob),
                      fill=color, outline=(40, 30, 20), width=4)
            d.ellipse((x0 + 104, 110, x0 + 118, 124), fill=(40, 30, 20))
            d.ellipse((x0 + 138, 110, x0 + 152, 124), fill=(40, 30, 20))
        _ensure_dir(out_path)
        im.save(out_path)


class CustomAdapter:
    """★ 在这里填你自己的图生图 API。只实现 generate() 一个方法即可。"""
    name = "custom"

    def generate(self, ref_path, prompt, out_path, config, meta=None):
        # TODO(你)：调用你的「参考图 + prompt -> 图」API，把结果图保存到 out_path。
        #
        # 入参：
        #   ref_path  参考图路径（保持角色身份用）
        #   prompt    固定动作模板文本（见 gen_prompts.py，不要改）
        #   out_path  输出 PNG 路径（本函数负责保存结果图）
        #   config    config.json 的 dict，放你的 api_key / model / size / base_url 等
        #   meta      可选 {'state','frame','strip_n'}，仅供调试，可忽略
        #
        # 示例（伪代码）：
        #   api_key = os.environ.get(config.get("api_key_env", "MY_IMAGE_API_KEY"))
        #   resp = your_api_call(
        #       reference_image=open(ref_path, "rb"),
        #       prompt=prompt,
        #       model=config.get("model"),
        #   )
        #   image_bytes = resp.image  # 或 base64 解码 / 下载 url
        #   _ensure_dir(out_path)
        #   with open(out_path, "wb") as f:
        #       f.write(image_bytes)
        raise NotImplementedError("请在 CustomAdapter.generate 里填你的图生图 API")


class OpenAIAdapter:
    """OpenAI Images API 参考实现（images.edit，带参考图）。需要 `pip install requests`。"""
    name = "openai"

    def generate(self, ref_path, prompt, out_path, config, meta=None):
        try:
            import requests
        except ImportError:
            raise RuntimeError("OpenAIAdapter 需要 requests：pip install requests")
        api_key = os.environ.get(config.get("api_key_env", "OPENAI_API_KEY"))
        if not api_key:
            raise RuntimeError("缺少 API key（环境变量 %s）" % config.get("api_key_env", "OPENAI_API_KEY"))
        model = config.get("model", "gpt-image-1")
        size = config.get("size", "1024x1024")
        base_url = (config.get("base_url") or "https://api.openai.com/v1").rstrip("/")
        data = {"model": model, "prompt": prompt, "size": size, "n": 1}
        files = {}
        if ref_path and os.path.exists(ref_path):
            with open(ref_path, "rb") as fh:
                files = {"image[]": (os.path.basename(ref_path), fh.read(), "image/png")}
        r = requests.post(base_url + "/images/edits",
                          headers={"Authorization": "Bearer " + api_key},
                          data=data, files=files, timeout=180)
        r.raise_for_status()
        item = r.json()["data"][0]
        _ensure_dir(out_path)
        if "b64_json" in item:
            import base64
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(item["b64_json"]))
        else:
            with requests.get(item["url"], timeout=180) as r2:
                r2.raise_for_status()
                with open(out_path, "wb") as f:
                    f.write(r2.content)


ADAPTERS = {"mock": MockAdapter, "custom": CustomAdapter, "openai": OpenAIAdapter}


def get_adapter(name):
    if name not in ADAPTERS:
        raise ValueError("未知 adapter %s，可用：%s" % (name, list(ADAPTERS)))
    return ADAPTERS[name]()
