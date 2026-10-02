# 제3자 고지

이 저장소가 배포·실행에 쓰는 제3자 소프트웨어의 고지다.

## @rhwp/core 0.8.6

- 용도: 뷰어(`packages/viewer`, `apps/viewer-poc`)가 HWPX를 화면에 그리고 클릭·글자 배치 위치를 얻는 데 쓰는 WebAssembly 라이브러리. 런타임 의존성이며 npm 배포본을 고친 것 없이 쓴다(`@rhwp/core`의 `rhwp.js`·`rhwp_bg.wasm`).
- 출처: https://www.npmjs.com/package/@rhwp/core (저장소 https://github.com/edwardkim/rhwp)
- 라이선스: MIT

패키지에 들어 있는 LICENSE 전문:

```
MIT License

Copyright (c) 2025-2026 Edward Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`@rhwp/core`는 자신이 포함한 오픈소스 Rust 크레이트(wasm-bindgen, quick-xml, cfb, flate2, encoding_rs, usvg, svg2pdf, pdf-writer, unicode-segmentation, unicode-width, image 등)의 고지를 패키지 README의 "Third-Party Licenses"와 https://github.com/edwardkim/rhwp/blob/main/THIRD_PARTY_LICENSES.md 에 둔다.

"한글", "한컴", "HWP", "HWPX"는 주식회사 한글과컴퓨터의 등록 상표다. `@rhwp/core`와 이 저장소는 한글과컴퓨터와 제휴·후원·승인 관계가 없다.
