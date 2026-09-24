// 中文习惯排版：正文仿宋；标题大于正文字号用 Noto 宋体，等于正文字号用黑体；着重/加粗用楷体
#let body-size = 12pt
#let 宋体 = ((name: "Times New Roman", covers: "latin-in-cjk"), "Noto Serif CJK SC")
#let 黑体 = ((name: "Times New Roman", covers: "latin-in-cjk"), "SimHei")
#let 楷体 = ((name: "Times New Roman", covers: "latin-in-cjk"), "KaiTi")
#let 仿宋 = ((name: "Times New Roman", covers: "latin-in-cjk"), "FangSong")

// 插图：不超过版心指定比例；小于该宽度时按原图像素尺寸显示，避免小截图被放大发糊
#let 插图(path, 题注, max-width: 1) = {
  figure(
    layout(size => {
      let limit = size.width * max-width
      let natural = measure(image(path))
      if natural.width > limit {
        image(path, width: limit, scaling: "smooth")
      } else {
        image(path, scaling: "smooth")
      }
    }),
    caption: 题注,
  )
}

#let 中文习惯排版(body) = {
  set page(
    paper: "a4",
    margin: (x: 2.5cm, y: 2.5cm),
    numbering: "1",
    number-align: center,
  )
  set text(
    font: 仿宋,
    size: body-size,
    lang: "zh",
    region: "CN",
    cjk-latin-spacing: auto,
  )
  set par(
    justify: true,
    first-line-indent: (amount: 2em, all: true),
  )
  set heading(numbering: none)

  // 标题：大于正文字号 → Noto 宋体；等于正文字号 → 黑体
  show heading: it => {
    let size = if it.level == 1 { 1.5em }
      else if it.level == 2 { 1.2em }
      else if it.level == 3 { 1.1em }
      else { 1em }
    let font = if size > 1em { 宋体 } else { 黑体 }
    set text(font: font, size: size, weight: "regular")
    if it.level == 1 {
      align(center, block(above: 1.2em, below: 1.2em, it.body))
    } else {
      block(above: 1.2em, below: 0.8em, it.body)
    }
  }

  // 着重 / 加粗 → 楷体
  show strong: it => text(font: 楷体, weight: "regular", it.body)
  show emph: it => text(font: 楷体, style: "normal", it.body)

  show link: it => text(fill: rgb("#0645AD"), it)
  show raw: set text(font: ("Consolas", "FangSong"), size: 0.92em)

  // 图/表阿拉伯数字编号（图1、表2等），题注与正文引用均自动生成，避免手写序号出错
  set figure(numbering: "1")
  show figure.where(kind: image): set figure(supplement: [图])
  show figure.where(kind: table): set figure(supplement: [表])
  show figure.where(kind: table): set figure.caption(position: top) // 表题在上、图题在下
  show figure: set block(above: 1.2em, below: 1.2em) // 图表前后留白
  show figure.caption: it => {
    set text(font: 楷体)
    context [
      #it.supplement#it.counter.display(it.numbering)
      #if it.body != [] [#h(1em)#it.body]
    ]
  }
  show ref: it => {
    let el = it.element
    if el != none and el.func() == figure {
      let n = counter(figure.where(kind: el.kind)).at(el.location())
      link(el.location(), [#el.supplement#numbering(el.numbering, ..n)])
    } else {
      it
    }
  }

  body
}
