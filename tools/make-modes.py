#!/usr/bin/env python3
"""Generate the King of the System / Survival level JSONs (web-only modes).

Same schema as the converted XM_Level files: description / objects / actions /
goals, plus the two new object types (`sun`, `region`) and the new goal
conditions (`MoreHillTime`, `MoreKills`).
"""
import json, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'levels')

SKIES = ['Sky2', 'Sky1', 'Sky3']
# Bases sit ~690 u from the centre: close enough that a respawned ship is back
# in the fight in ~10 s, far enough that the sun/region stay clear.
BASE_POS = {
    'human': '400|400|400',
    'alien': '-400|-400|-400',
    'falcon': '-400|400|-400',
    'viper': '400|-400|-400',
    'raptor': '-400|-400|400',
    'comet': '400|-400|400',
    'nova': '-400|400|400',
}

def ship(team, name, pos='around', model='Fighter3', life='100|100|100'):
    return {'team': team, 'type': 'spaceShipRespawn', 'model': model,
            'position': pos, 'name': name, 'life': life}

def base(team):
    return {'team': team, 'type': 'base', 'model': 'Base', 'position': BASE_POS[team]}

def kots_objects(teams, human_count, alien_count, solo_count):
    objs = [
        {'team': 'ambient', 'type': 'sun', 'model': '', 'position': '0|0|0', 'amount': 30},
        {'team': 'ambient', 'type': 'region', 'model': '', 'position': '0|0|0', 'amount': 150},
        {'team': 'ambient', 'type': 'miniStar', 'model': '', 'position': 'random', 'amount': 6000},
        {'team': 'ambient', 'type': 'cloud', 'model': '', 'position': 'random', 'amount': 700},
    ]
    if teams:
        objs.append(base('human'))
        objs.append(base('alien'))
        for i in range(1, human_count + 1):
            objs.append(ship('human', f'HS{i}'))
        for i in range(1, alien_count + 1):
            objs.append(ship('alien', f'AS{i}'))
    else:
        solo = ['human', 'falcon', 'viper', 'raptor', 'comet', 'nova'][:solo_count]
        for i, t in enumerate(solo):
            objs.append(base(t))
            objs.append(ship(t, f'{t[:1].upper()}S1' if i == 0 else f'{t[:2].upper()}1'))
    return objs

def kots_actions(teams, human_count, alien_count, solo_count):
    acts = [{'name': 'HILocal', 'from': 'HS1'}]
    if teams:
        for i in range(2, human_count + 1):
            acts.append({'name': 'AIKingOfHill', 'from': f'HS{i}'})
        for i in range(1, alien_count + 1):
            acts.append({'name': 'AIKingOfHill', 'from': f'AS{i}'})
    else:
        solo = ['falcon', 'viper', 'raptor', 'comet', 'nova'][:max(0, solo_count - 1)]
        for i, t in enumerate(solo):
            acts.append({'name': 'AIKingOfHill', 'from': f'{t[:2].upper()}1'})
    return acts

def surv_objects(teams, human_count, alien_count, solo_count):
    objs = [
        {'team': 'ambient', 'type': 'asteroid', 'model': 'Asteroid2', 'position': '400|200|-500', 'name': 'A1'},
        {'team': 'ambient', 'type': 'asteroid', 'model': 'Asteroid3', 'position': '-500|-300|400', 'name': 'A2'},
        {'team': 'ambient', 'type': 'asteroid', 'model': 'Asteroid1', 'position': '600|-600|-200', 'name': 'A3'},
        {'team': 'ambient', 'type': 'miniStar', 'model': '', 'position': 'random', 'amount': 6000},
        {'team': 'ambient', 'type': 'cloud', 'model': '', 'position': 'random', 'amount': 700},
    ]
    if teams:
        objs.append(base('human'))
        objs.append(base('alien'))
        for i in range(1, human_count + 1):
            objs.append(ship('human', f'HS{i}'))
        for i in range(1, alien_count + 1):
            objs.append(ship('alien', f'AS{i}'))
    else:
        solo = ['human', 'falcon', 'viper', 'raptor', 'comet', 'nova'][:solo_count]
        for i, t in enumerate(solo):
            objs.append(base(t))
            objs.append(ship(t, f'{t[:1].upper()}S1' if i == 0 else f'{t[:2].upper()}1'))
    return objs

def surv_actions(teams, human_count, alien_count, solo_count):
    acts = [{'name': 'HILocal', 'from': 'HS1'}]
    if teams:
        for i in range(2, human_count + 1):
            acts.append({'name': 'AIHunt' if i % 2 == 0 else 'AIGoRandomOffensive', 'from': f'HS{i}'})
        for i in range(1, alien_count + 1):
            acts.append({'name': 'AIHunt' if i % 2 == 1 else 'AIGoRandomOffensive', 'from': f'AS{i}'})
    else:
        solo = ['falcon', 'viper', 'raptor', 'comet', 'nova'][:max(0, solo_count - 1)]
        for i, t in enumerate(solo):
            acts.append({'name': 'AIHunt' if i % 2 == 0 else 'AIGoRandomOffensive', 'from': f'{t[:2].upper()}1'})
    return acts

DIFFS = [('easy', 4, 3, 4), ('normal', 4, 4, 5), ('hard', 4, 6, 6)]

KOTS_TEXT = (
    'The sun at the centre of the system is the prize: hold the green sphere '
    'around it longer than anyone else. Five minutes. Team or solo.'
)
SURV_TEXT = (
    'Five minutes of free fire: destroy as many ships as you can. Your ship '
    'respawns, your score does not. Team or solo.'
)

def write(key, mode, teams, diff, hc, ac, sc):
    n = DIFFS.index((diff, hc, ac, sc))
    kind = 'teams' if teams else 'solo'
    name = 'King of the System' if mode == 'KOTS' else 'Survival'
    title = f'{name} — {"Teams" if teams else "Solo"}'
    type_ = mode
    save = f'{mode}_{"T" if teams else "S"}_{diff[0].upper()}.svg'
    if mode == 'KOTS':
        objects, actions = kots_objects(teams, hc, ac, sc), kots_actions(teams, hc, ac, sc)
        goals = [
            {'reward': 'Victory', 'message': 'The system is yours!',
             'goals': [{'name': 'MoreTime', 'value': '00:05:00'}, {'name': 'MoreHillTime'}]},
            {'reward': 'Defeat', 'message': 'The system slipped away.',
             'goals': [{'name': 'MoreTime', 'value': '00:05:00'}]},
        ]
        text = KOTS_TEXT
    else:
        objects, actions = surv_objects(teams, hc, ac, sc), surv_actions(teams, hc, ac, sc)
        goals = [
            {'reward': 'Victory', 'message': 'You are the last one standing!',
             'goals': [{'name': 'MoreTime', 'value': '00:05:00'}, {'name': 'MoreKills'}]},
            {'reward': 'Defeat', 'message': 'Outgunned.',
             'goals': [{'name': 'MoreTime', 'value': '00:05:00'}]},
        ]
        text = SURV_TEXT
    data = {
        'source': f'Web/{name.replace(" ", "")}/{kind.title()}/{diff.title()}/Level.xml',
        'description': {'type': type_, 'name': title, 'save': save,
                        'sky': SKIES[n], 'size': 2048, 'text': ''},
        'imports': [],
        'objects': objects,
        'camara': {'name': 'LookAtObject', 'value': 'HS1'},
        'actions': actions,
        'goals': goals,
        'menuText': text,
        'scoreBoard': {'type': type_, 'save': save},
    }
    path = os.path.join(OUT, key + '.json')
    with open(path, 'w', encoding='utf8') as f:
        json.dump(data, f, indent=1)
        f.write('\n')
    return key, len(objects), len(actions)

if __name__ == '__main__':
    made = []
    for mode, key_base in (('KOTS', 'kots'), ('SURV', 'surv')):
        for teams, kind in ((True, 'teams'), (False, 'solo')):
            for diff, hc, ac, sc in DIFFS:
                made.append(write(f'{key_base}-{kind}-{diff}', mode, teams, diff, hc, ac, sc))
    for k, o, a in made:
        print(f'{k:22} objects={o:3} actions={a:3}')
