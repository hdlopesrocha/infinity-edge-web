// AI brains: port of src/game/ai.ts (13 command vocabularies) plus the
// HILocal player command driven by the session's PlayerInput.
#pragma once

#include <memory>

#include "sim.h"

namespace ie {

/** Homing-missile brain (the AIHoming command); used by SpaceShip::launchHoming. */
std::unique_ptr<Command> makeAIHoming(Game& gi, SpaceObject* target, SpaceObject* self);

}  // namespace ie
