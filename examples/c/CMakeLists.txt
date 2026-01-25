cmake_minimum_required(VERSION 3.15)
project(boxlite_c_examples C)

set(CMAKE_C_STANDARD 11)

# Find the BoxLite library
# Expected location: ../../target/release/libboxlite.{a,dylib,so}
set(BOXLITE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../..")
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

# Example executables
set(EXAMPLE_TARGETS
    execute
    shutdown
    simple_api_demo
    01_lifecycle
    02_list_boxes
    03_streaming_output
    04_error_handling
    05_metrics
)

foreach(TARGET ${EXAMPLE_TARGETS})
    add_executable(${TARGET} ${TARGET}.c)
    target_link_libraries(${TARGET} ${BOXLITE_LIB})
endforeach()

# Set RPATH so the executables can find the dylib
if(APPLE)
    set_target_properties(${EXAMPLE_TARGETS} PROPERTIES
        BUILD_RPATH "${BOXLITE_LIB_DIR}"
        INSTALL_RPATH "@executable_path/../lib"
    )
elseif(UNIX)
    set_target_properties(${EXAMPLE_TARGETS} PROPERTIES
        BUILD_RPATH "${BOXLITE_LIB_DIR}"
        INSTALL_RPATH "$ORIGIN/../lib"
    )
endif()

# Print instructions
message(STATUS "BoxLite C Examples Configuration:")
message(STATUS "  Include dir: ${BOXLITE_INCLUDE_DIR}")
message(STATUS "  Library: ${BOXLITE_LIB}")
message(STATUS "")
message(STATUS "To build and run:")
message(STATUS "  mkdir -p build && cd build")
message(STATUS "  cmake ..")
message(STATUS "  make")
message(STATUS "  ./execute")
