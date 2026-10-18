// AI brains: port of src/game/ai.ts (13 command vocabularies) plus the
// HILocal player command driven by the session's PlayerInput.
#pragma once

#include <memory>

#include "sim.h"

namespace ie {

/** Homing-missile brain (the AIHoming command); used by SpaceShip::launchHoming. */
std::unique_ptr<Command> makeAIHoming(Game& gi, SpaceObject* target, SpaceObject* self);

/**
 * The player's HILocal command. With `input == nullptr` it reads `gi.input`
 * (the WebSocket session's single player); a dedicated room passes the guest's
 * own PlayerInput and axis inversion instead.
 */
std::unique_ptr<Command> makeHILocal(Game& gi, SpaceObject* obj, const PlayerInput* input,
                                     bool invertX, bool invertY);

}  // namespace ie
