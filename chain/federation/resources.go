package federation

import (
	"errors"
	"math/big"
	"strings"
)

type ResourceOffer struct {
	ID               string `json:"id"`
	Provider         string `json:"provider"`
	ProviderInstance string `json:"provider_instance,omitempty"`
	Capability       string `json:"capability"`
	Class            string `json:"class"`
	Capacity         string `json:"capacity"`
	Unit             string `json:"unit"`
	TermsDigest      string `json:"terms_digest"`
	ExpiresHeight    int64  `json:"expires_height,string"`
	Height           int64  `json:"height,string"`
}
type ResourceOfferState struct {
	ID           string `json:"id"`
	Remaining    string `json:"remaining"`
	State        string `json:"state"`
	RecordDigest string `json:"record_digest"`
}
type ResourceAgreement struct {
	ID               string `json:"id"`
	Offer            string `json:"offer"`
	Provider         string `json:"provider"`
	ProviderInstance string `json:"provider_instance,omitempty"`
	Consumer         string `json:"consumer"`
	ConsumerInstance string `json:"consumer_instance,omitempty"`
	Units            string `json:"units"`
	PurposeDigest    string `json:"purpose_digest"`
	OfferDigest      string `json:"offer_digest"`
	Height           int64  `json:"height,string"`
}
type ResourceAgreementState struct {
	ID            string `json:"id"`
	State         string `json:"state"`
	RecordDigest  string `json:"record_digest"`
	ReceiptDigest string `json:"receipt_digest,omitempty"`
	AckDigest     string `json:"ack_digest,omitempty"`
}
type ResourceReceipt struct {
	Agreement        string `json:"agreement"`
	Provider         string `json:"provider"`
	ProviderInstance string `json:"provider_instance,omitempty"`
	Used             string `json:"used"`
	AgreementDigest  string `json:"agreement_digest"`
	EvidenceDigest   string `json:"evidence_digest"`
	ResultDigest     string `json:"result_digest"`
	Height           int64  `json:"height,string"`
}
type ResourceAcknowledgement struct {
	Agreement        string `json:"agreement"`
	Consumer         string `json:"consumer"`
	ConsumerInstance string `json:"consumer_instance,omitempty"`
	Verdict          string `json:"verdict"`
	ReceiptDigest    string `json:"receipt_digest"`
	EvidenceDigest   string `json:"evidence_digest"`
	Height           int64  `json:"height,string"`
}
type ResourceCollaboration struct {
	State           ResourceAgreementState   `json:"state"`
	Agreement       ResourceAgreement        `json:"agreement"`
	Offer           ResourceOffer            `json:"offer"`
	Receipt         *ResourceReceipt         `json:"receipt,omitempty"`
	Acknowledgement *ResourceAcknowledgement `json:"acknowledgement,omitempty"`
}

func resourceUnits(s string) (*big.Int, error) {
	v, err := money(s)
	if err != nil || v.Sign() <= 0 || !v.IsInt64() {
		return nil, errors.New("resource quantity needs a positive bounded integer")
	}
	return v, nil
}
func (k Keeper) resourceOffer(c Command, height int64) (string, error) {
	var p struct {
		ID            string `json:"id"`
		Capability    string `json:"capability"`
		Class         string `json:"class"`
		Capacity      string `json:"capacity"`
		Unit          string `json:"unit"`
		TermsDigest   string `json:"terms_digest"`
		ExpiresHeight int64  `json:"expires_height,string"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if _, err := resourceUnits(p.Capacity); err != nil {
		return "", err
	}
	if !validID(p.ID) || len(strings.TrimSpace(p.Capability)) < 10 || len(p.Capability) > 500 || !allowedClass(p.Class) || !validID(p.Unit) || !digestPattern.MatchString(p.TermsDigest) || p.ExpiresHeight <= height || p.ExpiresHeight-height > 1000000 || k.Store.Get([]byte("resource_offer/"+p.ID)) != nil {
		return "", errors.New("resource offer needs bounded capacity, expiry, permitted class and committed terms")
	}
	offer := ResourceOffer{p.ID, c.Member, c.Instance, p.Capability, p.Class, p.Capacity, p.Unit, p.TermsDigest, p.ExpiresHeight, height}
	digest, err := storeImmutable(k.Store, "resource_terms/"+p.ID, offer)
	if err != nil {
		return "", err
	}
	if err = put(k.Store, "resource_offer/"+p.ID, ResourceOfferState{p.ID, p.Capacity, "open", digest}); err != nil {
		return "", err
	}
	return p.ID, put(k.Store, "resource_offer_provider/"+operatorActorKey(c.Member, c.Instance)+"/"+p.ID, map[string]string{"offer": p.ID, "record_digest": digest})
}
func (k Keeper) loadResourceOffer(id string) (ResourceOfferState, ResourceOffer, error) {
	var state ResourceOfferState
	var offer ResourceOffer
	if err := get(k.Store, "resource_offer/"+id, &state); err != nil {
		return state, offer, err
	}
	if err := committedRecord(k.Store, "resource_terms/"+id, state.RecordDigest, &offer); err != nil {
		return state, offer, err
	}
	remaining, err := money(state.Remaining)
	if err != nil {
		return state, offer, err
	}
	capacity, err := resourceUnits(offer.Capacity)
	if err != nil {
		return state, offer, err
	}
	if state.ID != id || offer.ID != id || remaining.Cmp(capacity) > 0 || (state.State != "open" && state.State != "withdrawn") || !allowedClass(offer.Class) {
		return state, offer, errors.New("resource offer state differs from terms")
	}
	return state, offer, nil
}
func (k Keeper) resourceWithdraw(c Command) (string, error) {
	var p struct {
		Offer string `json:"offer"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	state, offer, err := k.loadResourceOffer(p.Offer)
	if err != nil {
		return "", err
	}
	if c.Member != offer.Provider || c.Instance != offer.ProviderInstance || state.State != "open" {
		return "", errors.New("only exact offering actor may withdraw an open offer")
	}
	state.State = "withdrawn"
	return p.Offer, put(k.Store, "resource_offer/"+p.Offer, state)
}
func (k Keeper) resourceAccept(c Command, height int64) (string, error) {
	var p struct {
		ID            string `json:"id"`
		Offer         string `json:"offer"`
		Units         string `json:"units"`
		PurposeDigest string `json:"purpose_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	units, err := resourceUnits(p.Units)
	if err != nil {
		return "", err
	}
	state, offer, err := k.loadResourceOffer(p.Offer)
	if err != nil {
		return "", err
	}
	provider, err := k.Member(offer.Provider)
	if err != nil {
		return "", err
	}
	if err = k.validateInstance(offer.Provider, offer.ProviderInstance); err != nil {
		return "", err
	}
	remaining, _ := money(state.Remaining)
	if !validID(p.ID) || !digestPattern.MatchString(p.PurposeDigest) || c.Member == offer.Provider || provider.Licence != "active" || state.State != "open" || height >= offer.ExpiresHeight || units.Cmp(remaining) > 0 || k.Store.Get([]byte("resource_agreement/"+p.ID)) != nil {
		return "", errors.New("resource acceptance exceeds current licensed offer or capacity")
	}
	agreement := ResourceAgreement{p.ID, p.Offer, offer.Provider, offer.ProviderInstance, c.Member, c.Instance, p.Units, p.PurposeDigest, state.RecordDigest, height}
	digest, err := storeImmutable(k.Store, "resource_acceptance/"+p.ID, agreement)
	if err != nil {
		return "", err
	}
	remaining.Sub(remaining, units)
	state.Remaining = remaining.String()
	if err = put(k.Store, "resource_offer/"+p.Offer, state); err != nil {
		return "", err
	}
	return p.ID, put(k.Store, "resource_agreement/"+p.ID, ResourceAgreementState{ID: p.ID, State: "accepted", RecordDigest: digest})
}
func (k Keeper) resourceReceipt(c Command, height int64) (string, error) {
	var p struct {
		Agreement      string `json:"agreement"`
		Used           string `json:"used"`
		EvidenceDigest string `json:"evidence_digest"`
		ResultDigest   string `json:"result_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	collaboration, err := k.ResourceCollaboration(p.Agreement)
	if err != nil {
		return "", err
	}
	state, a := collaboration.State, collaboration.Agreement
	used, err := resourceUnits(p.Used)
	if err != nil {
		return "", err
	}
	reserved, _ := resourceUnits(a.Units)
	if c.Member != a.Provider || c.Instance != a.ProviderInstance || state.State != "accepted" || used.Cmp(reserved) > 0 || height >= collaboration.Offer.ExpiresHeight || !digestPattern.MatchString(p.EvidenceDigest) || !digestPattern.MatchString(p.ResultDigest) {
		return "", errors.New("receipt needs exact supplier, unexpired bounded execution and committed results")
	}
	receipt := ResourceReceipt{a.ID, c.Member, c.Instance, p.Used, state.RecordDigest, p.EvidenceDigest, p.ResultDigest, height}
	// The raw, immutable receipt is small and is digest-bound to agreement state.
	if err = immutableJSON(k.Store, "resource_receipt/"+a.ID, receipt); err != nil {
		return "", err
	}
	state.ReceiptDigest = recordDigest(k.Store.Get([]byte("resource_receipt/" + a.ID)))
	state.State = "delivered"
	return a.ID, put(k.Store, "resource_agreement/"+a.ID, state)
}
func (k Keeper) resourceAcknowledge(c Command, height int64) (string, error) {
	var p struct {
		Agreement      string `json:"agreement"`
		Verdict        string `json:"verdict"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	collaboration, err := k.ResourceCollaboration(p.Agreement)
	if err != nil {
		return "", err
	}
	state, a := collaboration.State, collaboration.Agreement
	if c.Member != a.Consumer || c.Instance != a.ConsumerInstance || state.State != "delivered" || (p.Verdict != "accepted" && p.Verdict != "disputed") || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("only exact consumer may acknowledge or dispute one delivered receipt")
	}
	ack := ResourceAcknowledgement{a.ID, c.Member, c.Instance, p.Verdict, state.ReceiptDigest, p.EvidenceDigest, height}
	if err = immutableJSON(k.Store, "resource_ack/"+a.ID, ack); err != nil {
		return "", err
	}
	state.AckDigest = recordDigest(k.Store.Get([]byte("resource_ack/" + a.ID)))
	state.State = p.Verdict
	if p.Verdict == "accepted" {
		state.State = "complete"
	}
	return a.ID, put(k.Store, "resource_agreement/"+a.ID, state)
}

// ResourceCollaboration proves signed bilateral declarations and immutable
// execution receipts. Actual infrastructure use is evidenced outside consensus.
func (k Keeper) ResourceCollaboration(id string) (ResourceCollaboration, error) {
	var out ResourceCollaboration
	s := &out.State
	a := &out.Agreement
	if err := get(k.Store, "resource_agreement/"+id, s); err != nil {
		return out, err
	}
	if err := committedRecord(k.Store, "resource_acceptance/"+id, s.RecordDigest, a); err != nil {
		return out, err
	}
	if err := committedRecord(k.Store, "resource_terms/"+a.Offer, a.OfferDigest, &out.Offer); err != nil {
		return out, err
	}
	offer := out.Offer
	if _, err := resourceUnits(a.Units); err != nil {
		return out, err
	}
	units, _ := resourceUnits(a.Units)
	capacity, err := resourceUnits(offer.Capacity)
	if err != nil {
		return out, err
	}
	if s.ID != id || a.ID != id || a.Offer != offer.ID || a.Provider != offer.Provider || a.ProviderInstance != offer.ProviderInstance || a.Consumer == a.Provider || a.Height < offer.Height || a.Height >= offer.ExpiresHeight || units.Cmp(capacity) > 0 || !digestPattern.MatchString(a.PurposeDigest) || !allowedClass(offer.Class) {
		return out, errors.New("resource agreement differs from original offer")
	}
	if s.ReceiptDigest == "" {
		if s.State != "accepted" || s.AckDigest != "" {
			return out, errors.New("resource agreement lost its receipt binding")
		}
		return out, nil
	}
	var receipt ResourceReceipt
	raw := k.Store.Get([]byte("resource_receipt/" + id))
	if raw == nil || recordDigest(raw) != s.ReceiptDigest {
		return out, errors.New("missing or changed resource receipt")
	}
	if err = Decode(raw, &receipt); err != nil {
		return out, err
	}
	used, err := resourceUnits(receipt.Used)
	if err != nil {
		return out, err
	}
	if receipt.Agreement != id || receipt.AgreementDigest != s.RecordDigest || receipt.Provider != a.Provider || receipt.ProviderInstance != a.ProviderInstance || receipt.Height < a.Height || receipt.Height >= offer.ExpiresHeight || used.Cmp(units) > 0 || !digestPattern.MatchString(receipt.EvidenceDigest) || !digestPattern.MatchString(receipt.ResultDigest) {
		return out, errors.New("resource execution receipt binding differs")
	}
	out.Receipt = &receipt
	if s.AckDigest == "" {
		if s.State != "delivered" {
			return out, errors.New("resource acknowledgement absent")
		}
		return out, nil
	}
	var ack ResourceAcknowledgement
	raw = k.Store.Get([]byte("resource_ack/" + id))
	if raw == nil || recordDigest(raw) != s.AckDigest {
		return out, errors.New("missing or changed resource acknowledgement")
	}
	if err = Decode(raw, &ack); err != nil {
		return out, err
	}
	if ack.Agreement != id || ack.Consumer != a.Consumer || ack.ConsumerInstance != a.ConsumerInstance || ack.Height < receipt.Height || ack.ReceiptDigest != s.ReceiptDigest || !digestPattern.MatchString(ack.EvidenceDigest) || (ack.Verdict != "accepted" && ack.Verdict != "disputed") || (ack.Verdict == "accepted" && s.State != "complete") || (ack.Verdict == "disputed" && s.State != "disputed") {
		return out, errors.New("resource acknowledgement binding differs")
	}
	out.Acknowledgement = &ack
	return out, nil
}

type ResourceOfferView struct {
	State ResourceOfferState `json:"state"`
	Terms ResourceOffer      `json:"terms"`
}

func (k Keeper) ResourceOffer(id string) (ResourceOfferView, error) {
	state, offer, err := k.loadResourceOffer(id)
	return ResourceOfferView{state, offer}, err
}
