cmake_minimum_required(VERSION 3.15)
project(boxlite_c_tests C)

set(CMAKE_C_STANDARD 11)

# Find the BoxLite library
set(BOXLITE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../..")
set(BOXLITE_INCLUDE_DIR "${BOXLITE_ROOT}/sdks/c/include")
set(BOXLITE_LIB_DIR "${BOXLITE_ROOT}/target/release")

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
    message(FATAL_ERROR "BoxLite library not found at ${BOXLITE_LIB}. Please run: cargo build --release -p boxlite-c")
endif()

# Check if header exists
if(NOT EXISTS "${BOXLITE_INCLUDE_DIR}/boxlite.h")
    message(FATAL_ERROR "BoxLite header not found at ${BOXLITE_INCLUDE_DIR}/boxlite.h. Please run: cargo build --release -p boxlite-c")
endif()

# Include directories
include_directories(${BOXLITE_INCLUDE_DIR})

# Test executables
set(TEST_TARGETS
    test_basic
    test_lifecycle
    test_execute
    test_errors
    test_simple_api
    test_streaming
    test_memory
    test_integration
)

foreach(TARGET ${TEST_TARGETS})
    add_executable(${TARGET} ${TARGET}.c)
    target_link_libraries(${TARGET} ${BOXLITE_LIB})

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

# Auto-discover runtime directory
# Priority: BOXLITE_RUNTIME_DIR env > target/boxlite-runtime (from `make runtime`)
# The runtime directory contains: boxlite-guest, mke2fs, debugfs, libkrun, libgvproxy, etc.
if(DEFINED ENV{BOXLITE_RUNTIME_DIR})
    set(BOXLITE_RUNTIME_DIR "$ENV{BOXLITE_RUNTIME_DIR}")
elseif(EXISTS "${BOXLITE_ROOT}/target/boxlite-runtime")
    set(BOXLITE_RUNTIME_DIR "${BOXLITE_ROOT}/target/boxlite-runtime")
else()
    # Fallback: try to find the build output from boxlite crate
    file(GLOB _RUNTIME_CANDIDATES "${BOXLITE_ROOT}/target/release/build/boxlite-*/out/runtime")
    list(LENGTH _RUNTIME_CANDIDATES _NUM_CANDIDATES)
    if(_NUM_CANDIDATES GREATER 0)
        list(GET _RUNTIME_CANDIDATES 0 BOXLITE_RUNTIME_DIR)
    else()
        set(BOXLITE_RUNTIME_DIR "")
    endif()
endif()

# Add tests with runtime environment
foreach(TARGET ${TEST_TARGETS})
    add_test(NAME ${TARGET} COMMAND ${TARGET})
    if(BOXLITE_RUNTIME_DIR)
        set_tests_properties(${TARGET} PROPERTIES
            ENVIRONMENT "BOXLITE_RUNTIME_DIR=${BOXLITE_RUNTIME_DIR};DYLD_LIBRARY_PATH=${BOXLITE_RUNTIME_DIR}:${BOXLITE_LIB_DIR}"
        )
    endif()
endforeach()

# Print instructions
if(BOXLITE_RUNTIME_DIR)
    message(STATUS "  Runtime dir: ${BOXLITE_RUNTIME_DIR}")
else()
    message(WARNING "Runtime directory not found. Tests requiring VM (execute, streaming, etc.) will fail.")
    message(WARNING "Run 'make runtime' from the project root first, or set BOXLITE_RUNTIME_DIR.")
endif()

message(STATUS "BoxLite C Tests Configuration:")
message(STATUS "  Include dir: ${BOXLITE_INCLUDE_DIR}")
message(STATUS "  Library: ${BOXLITE_LIB}")
message(STATUS "  Test targets: ${TEST_TARGETS}")
message(STATUS "")
message(STATUS "Prerequisites:")
message(STATUS "  1. cargo build --release -p boxlite-c   (build libboxlite)")
message(STATUS "  2. make runtime                         (build runtime binaries)")
message(STATUS "")
message(STATUS "To build and run tests:")
message(STATUS "  mkdir -p build && cd build")
message(STATUS "  cmake ..")
message(STATUS "  make")
message(STATUS "  ctest --verbose")
message(STATUS "")
message(STATUS "To run individual test:")
message(STATUS "  ./test_basic")
