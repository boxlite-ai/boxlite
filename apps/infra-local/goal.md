作为 boxlite 的开发者, 我们去设计并实现完整的 infra-local。
我们 boxlite 新加了一条 principle: eat your own dog food.
  
所以我需要你基于目前的 infra-local方案， 新构建一个不使用docker 而是使用 boxlite去 run boxlite 的 box 并在 box 中 run 相应的docker image。从而达到用我们 boxlite 的能力去搭建全套 infra-local 的方案实现。

1、熟悉 boxlite python sdk 方式的使用。
2、基于 boxlite python sdk 的方式， 用不同的 python 
脚本去启动需要的组件及服务吗, 或者实现成用同一个 python 但接受不同的配置文件的方式去启动我们需要的不同组件服务
3、基于 (../../docs/apps/infra-vs-local-infra.md) 和 boxlite 的 python SDK 的使用方式， 设计一套新的方案： own-dog-food-local-infra-solution.md