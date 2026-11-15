package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// Monetary review independence survives profile unlinking and key rotation.
// These markers record proved control, never ownership inferred from an address.
func (k Keeper) rememberFundingSourceControl(prefix, network, address, member string) error {
	indexKey := prefix + "_controllers/" + network + "/" + address
	controllers, err := k.fundingSourceControllers(indexKey)
	if err != nil {
		return err
	}
	found := false
	for _, id := range controllers {
		if id == member {
			found = true
		}
	}
	if !found {
		if len(controllers) >= 20 {
			return errors.New("funding source controller history limit reached")
		}
		controllers = append(controllers, member)
		if err = put(k.Store, indexKey, controllers); err != nil {
			return err
		}
	}
	if e := put(k.Store, prefix+"/"+network+"/"+address+"/"+member, true); e != nil {
		return e
	}
	proof, e := k.OperatorProof(member, "")
	if e != nil {
		return e
	}
	if proof != nil {
		domain := sha256.Sum256([]byte(proof.Domain))
		return put(k.Store, prefix+"_domain/"+network+"/"+address+"/"+hex.EncodeToString(domain[:]), true)
	}
	return nil
}
func (k Keeper) independentFundingSource(prefix, network, address, member string) error {
	if k.Store.Get([]byte(prefix+"/"+network+"/"+address+"/"+member)) != nil {
		return errors.New("observer previously proved funding source control")
	}
	proof, e := k.OperatorProof(member, "")
	if e != nil {
		return e
	}
	if proof != nil {
		controllers, err := k.fundingSourceControllers(prefix + "_controllers/" + network + "/" + address)
		if err != nil {
			return err
		}
		for _, controller := range controllers {
			current, err := k.OperatorProof(controller, "")
			if err != nil {
				return err
			}
			if current != nil && current.Domain == proof.Domain {
				return errors.New("observer shares a proved funding source controller operator")
			}
		}
		domain := sha256.Sum256([]byte(proof.Domain))
		if k.Store.Get([]byte(prefix+"_domain/"+network+"/"+address+"/"+hex.EncodeToString(domain[:]))) != nil {
			return errors.New("observer operator previously proved funding source control")
		}
	}
	return nil
}

func (k Keeper) fundingSourceControllers(key string) ([]string, error) {
	var controllers []string
	if k.Store.Get([]byte(key)) == nil {
		return controllers, nil
	}
	if err := get(k.Store, key, &controllers); err != nil {
		return nil, err
	}
	if len(controllers) > 20 {
		return nil, errors.New("funding source controller history exceeds limit")
	}
	seen := map[string]bool{}
	for _, id := range controllers {
		if !coinBoundaryMember.MatchString(id) || seen[id] {
			return nil, errors.New("invalid funding source controller history")
		}
		seen[id] = true
	}
	return controllers, nil
}
