cmake_minimum_required(VERSION 3.16)
project(infinityedge-server LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(ZLIB REQUIRED)
find_package(OpenSSL REQUIRED)

# Dedicated multiplayer mode: WebRTC data channels come from libdatachannel
# (MIT; fetched at configure time, cached in the build directory afterwards).
include(FetchContent)
set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
set(NO_TESTS ON CACHE BOOL "" FORCE)
set(NO_WEBSOCKET ON CACHE BOOL "" FORCE)
set(NO_MEDIA ON CACHE BOOL "" FORCE)
# libusrsctp is packaged by common distributions; only libjuice (ICE) and plog
# (logging) are fetched as submodules - the json submodule is examples-only.
set(USE_SYSTEM_USRSCTP ON CACHE BOOL "" FORCE)
FetchContent_Declare(datachannel
  GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
  GIT_TAG v0.23.2
  GIT_SHALLOW TRUE
  GIT_SUBMODULES "deps/libjuice;deps/plog"
  GIT_SUBMODULES_RECURSE FALSE)
FetchContent_MakeAvailable(datachannel)

# The simulation + protocol core (no sockets): the same translation units the
# tests link against.
add_library(ie_sim STATIC
  src/json.cpp
  src/crypto.cpp
  src/nostr_crypto.cpp
  src/nostr.cpp
  src/wsc.cpp
  src/gzip.cpp
  src/proto.cpp
  src/ws.cpp
  src/sim_octree.cpp
  src/sim_objects.cpp
  src/sim_game.cpp
  src/ai.cpp
  src/match.cpp
  src/session.cpp
)
target_include_directories(ie_sim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(ie_sim PUBLIC ZLIB::ZLIB OpenSSL::SSL OpenSSL::Crypto)
target_compile_options(ie_sim PRIVATE -Wall -Wextra)

add_executable(ie-server src/main.cpp src/server.cpp src/dedicated.cpp)
target_link_libraries(ie-server PRIVATE ie_sim LibDataChannel::LibDataChannel)
target_compile_options(ie-server PRIVATE -Wall -Wextra)

enable_testing()
add_executable(test_sim tests/test_sim.cpp)
target_link_libraries(test_sim PRIVATE ie_sim)
target_compile_options(test_sim PRIVATE -Wall -Wextra)
add_test(NAME sim COMMAND test_sim ${CMAKE_CURRENT_SOURCE_DIR}/..)

add_executable(test_nostr tests/test_nostr.cpp)
target_link_libraries(test_nostr PRIVATE ie_sim)
target_compile_options(test_nostr PRIVATE -Wall -Wextra)
add_test(NAME nostr COMMAND test_nostr)
