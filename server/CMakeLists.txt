cmake_minimum_required(VERSION 3.16)
project(infinityedge-server LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(ZLIB REQUIRED)

# The simulation + protocol core (no sockets): the same translation units the
# tests link against.
add_library(ie_sim STATIC
  src/json.cpp
  src/crypto.cpp
  src/gzip.cpp
  src/proto.cpp
  src/ws.cpp
  src/sim_octree.cpp
  src/sim_objects.cpp
  src/sim_game.cpp
  src/ai.cpp
  src/session.cpp
)
target_include_directories(ie_sim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(ie_sim PUBLIC ZLIB::ZLIB)
target_compile_options(ie_sim PRIVATE -Wall -Wextra)

add_executable(ie-server src/main.cpp src/server.cpp)
target_link_libraries(ie-server PRIVATE ie_sim)
target_compile_options(ie-server PRIVATE -Wall -Wextra)

enable_testing()
add_executable(test_sim tests/test_sim.cpp)
target_link_libraries(test_sim PRIVATE ie_sim)
target_compile_options(test_sim PRIVATE -Wall -Wextra)
add_test(NAME sim COMMAND test_sim ${CMAKE_CURRENT_SOURCE_DIR}/..)
