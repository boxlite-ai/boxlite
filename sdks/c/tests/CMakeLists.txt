cmake_minimum_required(VERSION 3.15)
project(boxlite_c_tests C)

set(CMAKE_C_STANDARD 11)

# Find the BoxLite library
set(BOXLITE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../..")
set(BOXLITE_INCLUDE_DIR "${BOXLITE_ROOT}/sdks/c/include")
set(BOXLITE_LIB_DIR "${BOXLITE_ROOT}/target/debug")

# Detect platform and set library name
if(APPLE)
    set(BOXLITE_LIB "${BOXLITE_LIB_DIR}/libboxlite.dylib")
elseif(UNIX)
    set(BOXLITE_LIB "${BOXLITE_LIB_DIR}/libboxlite.so")
else()
    message(FATAL_ERROR "Unsupported platform")
endif()

# Check if library exists
if(NOT EXISTS "${BOXLITE_LIB}")
    message(FATAL_ERROR "BoxLite library not found at ${BOXLITE_LIB}. Please run: make dev:c")
endif()

# Check if header exists
if(NOT EXISTS "${BOXLITE_INCLUDE_DIR}/boxlite.h")
    message(FATAL_ERROR "BoxLite header not found at ${BOXLITE_INCLUDE_DIR}/boxlite.h. Please run: make dev:c")
endif()

# Include directories
include_directories(${BOXLITE_INCLUDE_DIR})

# Test executables.
# Note: lifecycle/execute/streaming/etc. tests were removed when the C SDK
# moved to the post-and-drain callback API; coverage of those code paths now
# lives in the Go SDK + runner integration suite.
set(TEST_TARGETS
    test_simple_api
    test_null_callback
)

foreach(TARGET ${TEST_TARGETS})
    add_executable(${TARGET} ${TARGET}.c)
    target_link_libraries(${TARGET} ${BOXLITE_LIB})
    target_compile_definitions(${TARGET} PRIVATE _XOPEN_SOURCE=500)

    # Set RPATH so the executable can find the dylib
    if(APPLE)
        set_target_properties(${TARGET} PROPERTIES
            BUILD_RPATH "${BOXLITE_LIB_DIR}"
            INSTALL_RPATH "@executable_path/../lib"
        )
    elseif(UNIX)
        set_target_properties(${TARGET} PROPERTIES
            BUILD_RPATH "${BOXLITE_LIB_DIR}"
            INSTALL_RPATH "$ORIGIN/../lib"
        )
    endif()
endforeach()

# Enable testing
enable_testing()

# Register tests
foreach(TARGET ${TEST_TARGETS})
    add_test(NAME ${TARGET} COMMAND ${TARGET})
endforeach()

# Label integration tests (require VM)
set_tests_properties(test_simple_api PROPERTIES LABELS "integration")
# test_null_callback only exercises the FFI argument-validation path;
# no VM is required, but we still link the runtime dylib.
set_tests_properties(test_null_callback PROPERTIES LABELS "ffi")

message(STATUS "BoxLite C Tests Configuration:")
message(STATUS "  Include dir: ${BOXLITE_INCLUDE_DIR}")
message(STATUS "  Library: ${BOXLITE_LIB}")
message(STATUS "  Test targets: ${TEST_TARGETS}")
message(STATUS "")
message(STATUS "Prerequisite: make dev:c")
message(STATUS "")
message(STATUS "To build and run tests:")
message(STATUS "  mkdir -p build && cd build")
message(STATUS "  cmake ..")
message(STATUS "  make")
message(STATUS "  ctest --verbose")
