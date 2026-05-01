#pragma once

#if __has_include("include/boxlite.h")
#include "include/boxlite.h"
#elif __has_include("../c/include/boxlite.h")
#include "../c/include/boxlite.h"
#else
#error "boxlite.h not found; run go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup"
#endif
